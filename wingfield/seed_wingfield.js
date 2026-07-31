// seed_wingfield.js - imports the parsed Wingfield Business Park workbook JSON (produced by
// extract_wingfield.py, one file per month, July 2025 - July 2026) into Wingfield's own SQLite
// database (see properties.js: dbFile 'wingfield.db', completely separate from City Deep's
// 'city-deep.db' - no shared tables, no property_id column to forget in a WHERE clause).
//
// Mirrors seed.js's structure and discipline (independently recompute every bill from raw
// consumption + tariff rates via calc_wingfield.js, store the workbook's own cached totals in
// excel_reference purely for the reconciliation report, document quirks instead of silently
// "fixing" them) but is intentionally its own file rather than a generic property-agnostic
// importer: Wingfield's tariff structure, sheet layout, and a handful of source-data quirks
// (see below) are different enough from City Deep's that sharing one script would mean threading
// property-specific special cases through a single function - two small clear scripts beat one
// tangled one.
const fs = require('fs');
const path = require('path');
const { open, migrate } = require('../db');
const calc = require('./calc_wingfield');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');

let db;

function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }

// ---------- Users ----------
// Same shared-login pool as every other property (see shared_seed_users.js) - one set of
// admin/billing/reviewer/viewer credentials works across the whole platform (user's explicit
// choice, not assumed).
function seedUsers() {
  if (seedUsersShared(db)) {
    console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');
  }
}

// ---------- Tenant name aliasing ----------
// The Electrical Billing and Water Billing sheets spell a handful of the same real tenant
// differently between the two sheets (confirmed by cross-checking meter serials/locations, not
// guessed): 'Cards Plus' vs 'Card Plus', 'TRVSA' vs 'TRSAV' (a transposition typo on one side -
// which spelling is "correct" is not determinable from the data alone, so 'TRVSA' - the
// Electrical Billing spelling - was picked as canonical, arbitrarily but consistently), and
// 'Common Area/Refinery' vs 'Common area'. Filenames also vary a trailing-space/suffix on the
// Electrical side across months ('Overnight Logistics ', 'Sange SA ', one month's
// 'Arch International Logistics (Pyt) Ltd' vs every other month's 'Arch International
// Logistics'). All names are trimmed first, then run through this map.
const TENANT_NAME_ALIASES = {
  'Card Plus': 'Cards Plus',
  'TRSAV': 'TRVSA',
  'Common area': 'Common Area/Refinery',
  'Arch International Logistics (Pyt) Ltd': 'Arch International Logistics',
};
function canonicalTenantName(name) {
  const trimmed = (name || '').trim();
  return TENANT_NAME_ALIASES[trimmed] || trimmed;
}

// These three blocks are bulk/reference supply meters, not tenants - 'Main Council Meter' and
// 'Subatation Totals' on the electrical side, and (by the same logic, same magnitude of scale -
// R126,175 for July 2026 alone vs the largest real tenant water bill of ~R10,700) 'Council' on
// the water side. Its own meter serials (100087357, 60351776, 8SEN0118757810, CRICW617N) match
// the raw 'Water' sheet's own labels for the bulk Council supply/check meters. Matches the user's
// explicit decision to exclude the electrical bulk meters from tenant billing, extended here to
// water's equivalent bulk meter for consistency. Their raw readings are still imported (see
// seedBulkMeters below) so nothing is silently discarded - they just never generate a tenant bill.
const EXCLUDED_TENANT_NAMES = new Set(['Main Council Meter', 'Subatation Totals', 'Council']);

// ---------- Tariffs ----------
// buildWingfieldTariffParams lives in calc_wingfield.js (shared with the calc engine itself, so
// the B-cell mapping is defined in exactly one place). Confirmed against the Tariff sheet's own
// row labels: B3 Basic charge, B4 Capacity charge (R/Amp), B8 "Active Tariff" (the sheet's own
// season-resolved low/high energy rate - reused as-is rather than re-deriving winter/summer
// ourselves), B12 Water usage, B13 Sewage.
function seedTariffsAndPeriod(monthData) {
  const { period, tariff_raw, label } = monthData;
  const tariff = calc.buildWingfieldTariffParams(tariff_raw);

  let bp = get('SELECT * FROM billing_periods WHERE label = ?', [label]);
  if (!bp) {
    run('INSERT INTO billing_periods (label, start_date, end_date, invoice_date, due_date) VALUES (?,?,?,?,?)',
      [label, period.start, period.end, period.end, period.end]);
    bp = get('SELECT * FROM billing_periods WHERE label = ?', [label]);
  }

  const tariffDefs = [
    ['electricity', null, 'Wingfield Electrical (basic + capacity + energy)'],
    ['water', null, 'Wingfield Water / Sewage'],
  ];
  for (const [utility, code, name] of tariffDefs) {
    let t = get('SELECT * FROM tariffs WHERE utility_type=? AND (code IS ?)', [utility, code]);
    if (!t) {
      run('INSERT INTO tariffs (utility_type, code, name) VALUES (?,?,?)', [utility, code, name]);
      t = get('SELECT * FROM tariffs WHERE utility_type=? AND (code IS ?)', [utility, code]);
    }
    const params = utility === 'electricity'
      ? { basicCharge: tariff.basicCharge, capacityRatePerAmp: tariff.capacityRatePerAmp, energyRate: tariff.energyRate }
      : { waterRate: tariff.waterRate, sanitationRate: tariff.sanitationRate };
    const openVersion = get('SELECT * FROM tariff_versions WHERE tariff_id=? AND effective_to IS NULL', [t.id]);
    const json = JSON.stringify(params);
    if (!openVersion || openVersion.params_json !== json) {
      if (openVersion) run('UPDATE tariff_versions SET effective_to=? WHERE id=?', [period.start, openVersion.id]);
      run('INSERT INTO tariff_versions (tariff_id, effective_from, effective_to, params_json, vat_rate) VALUES (?,?,?,?,?)',
        [t.id, period.start, null, json, 0.15]);
    }
  }
  return { billingPeriod: bp, tariff };
}

// ---------- Tenants / Meters ----------
const SITE_NAME = 'Wingfield Business Park';
function getOrCreateTenant(name) {
  let site = get('SELECT * FROM sites WHERE name=?', [SITE_NAME]);
  if (!site) { run('INSERT INTO sites (name) VALUES (?)', [SITE_NAME]); site = get('SELECT * FROM sites WHERE name=?', [SITE_NAME]); }
  let tenant = get('SELECT * FROM tenants WHERE name=?', [name]);
  if (!tenant) {
    run('INSERT INTO tenants (site_id, name, unit, status) VALUES (?,?,?,?)', [site.id, name, null, 'active']);
    tenant = get('SELECT * FROM tenants WHERE name=?', [name]);
  }
  return tenant;
}

function getOrCreateMeter(serial, utilityType, role, location) {
  let m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  if (!m) {
    run('INSERT INTO meters (serial, utility_type, role, location, unit_scale) VALUES (?,?,?,?,1)', [serial, utilityType, role, location]);
    m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  }
  return m;
}

function upsertAssignment({ meterId, tenantId, sign, breakerAmp, periodStart }) {
  const open = get('SELECT * FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL ORDER BY id DESC LIMIT 1', [meterId]);
  const same = open && open.tenant_id === tenantId && open.sign === sign &&
    Math.abs((open.capacity_charge_override ?? 0) - (breakerAmp ?? 0)) < 1e-6;
  if (same) return open;
  if (open) run('UPDATE meter_assignments SET effective_to=? WHERE id=?', [periodStart, open.id]);
  run(`INSERT INTO meter_assignments
      (meter_id, tenant_id, tariff_code, service_charge_flag, sign, allocation_pct, capacity_charge_override, effective_from)
      VALUES (?,?,?,?,?,?,?,?)`,
    [meterId, tenantId, null, 1, sign, 1, breakerAmp ?? null, periodStart]);
  return get('SELECT * FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL', [meterId]);
}

// A handful of meters physically sit on one tenant's board but are billed to a different tenant
// (e.g. an MTN or Vodacom antenna wired through another tenant's DB). Confirmed by cross-checking
// the source sheet: the antenna's meter appears twice each month - once as a positive charge
// under its real payer (MTN/Vodacom), and once inside the host tenant's own block as an equal and
// opposite negative "energy_charge" line, netting the load back out of the host's bill. Sign is
// detected from that polarity rather than a hardcoded meter/tenant list - safer against next
// month's roster changing.
//
// `hasBasicCharge`/`hasCapacityCharge` are read independently, straight off whether the source
// row's own basic_charge/capacity_charge columns are populated - confirmed these are two separate,
// consistent business rules (not "credit rows only"): every row in the "Common Area/Refinery"
// block, for instance, carries a basic charge but never a capacity charge, all 13 months.
//
// Quantity is taken as the absolute value of the source consumption reading, not the raw signed
// figure: one row in Nov 2025 ("Lear Security Meter Entrance") has a meter-rollover artifact
// (end < start, so raw consumption reads negative) but a genuine positive energy_charge - Excel's
// own figure confirms the true billed direction is positive, so abs(consumption) with the
// detected sign reproduces it exactly, while still correctly flipping true credit rows negative.
function signAndCharges(row) {
  const isCredit = (row.energy_charge != null && row.energy_charge < 0) || (row.row_total != null && row.row_total < 0);
  return {
    sign: isCredit ? -1 : 1,
    hasBasicCharge: row.basic_charge != null,
    hasCapacityCharge: row.capacity_charge != null,
  };
}

// ---------- Bill generation ----------
function generateBill(tenant, billingPeriod, elecMeterRows, waterMeterRows, tariff) {
  const lineItems = [];
  let elecKwhTotal = 0, waterKlTotal = 0;

  for (const row of elecMeterRows) {
    const meter = getOrCreateMeter(row.serial, 'electricity', 'tenant', row.location);
    run(`INSERT OR REPLACE INTO meter_readings (meter_id, billing_period_id, start_reading, end_reading, source)
         VALUES (?,?,?,?,?)`, [meter.id, billingPeriod.id, row.start || 0, row.end || 0, 'excel_import']);

    const { sign, hasBasicCharge, hasCapacityCharge } = signAndCharges(row);
    const consumptionKwh = Math.abs(row.consumption || 0);
    const breakerAmp = hasCapacityCharge ? row.breaker : null;
    upsertAssignment({ meterId: meter.id, tenantId: tenant.id, sign, breakerAmp, periodStart: billingPeriod.start_date });

    const result = calc.calcElectricityMeterLine({
      consumptionKwh, breakerAmp, sign, hasBasicCharge, tariff,
    });
    for (const li of result.lineItems) lineItems.push({ ...li, meter_id: meter.id, utility_type: 'electricity' });
    elecKwhTotal += consumptionKwh * sign;
  }

  for (const row of waterMeterRows) {
    const meter = getOrCreateMeter(row.serial, 'water', 'tenant', null);
    run(`INSERT OR REPLACE INTO meter_readings (meter_id, billing_period_id, start_reading, end_reading, source)
         VALUES (?,?,?,?,?)`, [meter.id, billingPeriod.id, row.start || 0, row.end || 0, 'excel_import']);

    upsertAssignment({ meterId: meter.id, tenantId: tenant.id, sign: 1, breakerAmp: null, periodStart: billingPeriod.start_date });

    const result = calc.calcWaterMeterLine({ consumptionKl: row.consumption, tariff });
    for (const li of result.lineItems) lineItems.push({ ...li, meter_id: meter.id, utility_type: 'water' });
    waterKlTotal += row.consumption || 0;
  }

  const subtotal = calc.sumLineItems(lineItems);
  const vatRate = 0.15;
  const vatAmount = calc.round2(subtotal * vatRate);
  const total = calc.round2(subtotal + vatAmount);

  run('DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE tenant_id=? AND billing_period_id=?)', [tenant.id, billingPeriod.id]);
  run('DELETE FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, billingPeriod.id]);
  run(`INSERT INTO bills (tenant_id, billing_period_id, status, subtotal_excl_vat, vat_rate, vat_amount, total_incl_vat,
        electricity_consumption_kwh, water_consumption_m3, invoice_number)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [tenant.id, billingPeriod.id, 'finalised', subtotal, vatRate, vatAmount, total, calc.round2(elecKwhTotal), calc.round2(waterKlTotal),
     `WF-${billingPeriod.label}-${tenant.id}`]);
  const bill = get('SELECT * FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, billingPeriod.id]);
  for (const li of lineItems) {
    run('INSERT INTO bill_line_items (bill_id, meter_id, utility_type, category, description, quantity, rate, amount) VALUES (?,?,?,?,?,?,?,?)',
      [bill.id, li.meter_id, li.utility_type, li.category, li.description, li.quantity, li.rate, li.amount]);
  }
  return { bill, subtotal };
}

// Main Council Meter / Subatation Totals (electrical) and Council (water) are excluded from
// tenant billing (see EXCLUDED_TENANT_NAMES) but their raw readings are still imported here as
// role='bulk' meters purely so nothing from the source workbook is silently dropped - same
// pattern as seed.js's SOLAR_BULK_EXPORT_METERS for City Deep's mini-substation meters.
function seedBulkMeters(monthData, billingPeriod) {
  const bulkBlocks = [
    ...monthData.electrical_billing.filter((t) => EXCLUDED_TENANT_NAMES.has(canonicalTenantName(t.name))),
    ...monthData.water_billing.filter((t) => EXCLUDED_TENANT_NAMES.has(canonicalTenantName(t.name))),
  ];
  for (const block of bulkBlocks) {
    const utilityType = monthData.electrical_billing.includes(block) ? 'electricity' : 'water';
    for (const row of block.meters) {
      const meter = getOrCreateMeter(row.serial, utilityType, 'bulk', row.location || block.name);
      run(`INSERT OR REPLACE INTO meter_readings (meter_id, billing_period_id, start_reading, end_reading, source)
           VALUES (?,?,?,?,?)`, [meter.id, billingPeriod.id, row.start || 0, row.end || 0, 'excel_import']);
    }
  }
}

function seedMonth(monthData) {
  const { billingPeriod, tariff } = seedTariffsAndPeriod(monthData);
  const elecTenantsByName = {};
  for (const t of monthData.electrical_billing) elecTenantsByName[canonicalTenantName(t.name)] = t;
  const waterTenantsByName = {};
  for (const t of monthData.water_billing) waterTenantsByName[canonicalTenantName(t.name)] = t;

  const allNames = new Set([...Object.keys(elecTenantsByName), ...Object.keys(waterTenantsByName)]);
  let count = 0;
  for (const name of allNames) {
    if (EXCLUDED_TENANT_NAMES.has(name)) continue;
    const tenant = getOrCreateTenant(name);
    const elecBlock = elecTenantsByName[name];
    const waterBlock = waterTenantsByName[name];
    generateBill(tenant, billingPeriod, elecBlock ? elecBlock.meters : [], waterBlock ? waterBlock.meters : [], tariff);

    if (elecBlock && elecBlock.totals) {
      run(`INSERT OR REPLACE INTO excel_reference (tenant_id, billing_period_id, utility_type, consumption, charge_total_excl_vat)
           VALUES (?,?,?,?,?)`,
        [tenant.id, billingPeriod.id, 'electricity',
         elecBlock.meters.reduce((s, m) => s + Math.abs(m.consumption || 0) * signAndCharges(m).sign, 0),
         elecBlock.totals.row_total]);
    }
    if (waterBlock && waterBlock.totals) {
      run(`INSERT OR REPLACE INTO excel_reference (tenant_id, billing_period_id, utility_type, consumption, charge_total_excl_vat)
           VALUES (?,?,?,?,?)`,
        [tenant.id, billingPeriod.id, 'water',
         waterBlock.meters.reduce((s, m) => s + (m.consumption || 0), 0),
         waterBlock.totals.row_total]);
    }
    count++;
  }
  seedBulkMeters(monthData, billingPeriod);
  console.log(`Seeded ${count} tenants for period ${monthData.label} (${billingPeriod.start_date} - ${billingPeriod.end_date})`);
}

// All 13 imported months, July 2025 - July 2026 (see extract_wingfield.py for why filenames,
// not period-end dates, were used as labels - the "Aug 2025" file's own internal period falls
// entirely within July, which would otherwise collide with the real July file's label).
const MONTH_FILES = [
  'wingfield_2025-07.json', 'wingfield_2025-08.json', 'wingfield_2025-09.json', 'wingfield_2025-10.json',
  'wingfield_2025-11.json', 'wingfield_2025-12.json', 'wingfield_2026-01.json', 'wingfield_2026-02.json',
  'wingfield_2026-03.json', 'wingfield_2026-04.json', 'wingfield_2026-05.json', 'wingfield_2026-06.json',
  'wingfield_2026-07.json',
];

function main(dbFile = 'wingfield.db') {
  db = open(dbFile);
  migrate(db);
  const months = MONTH_FILES
    .map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'imports', f), 'utf8')))
    .sort((a, b) => (a.period.start || '').localeCompare(b.period.start || ''));
  db.exec('BEGIN');
  try {
    seedUsers();
    for (const monthData of months) seedMonth(monthData);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`Seed complete (${months.length} months) into ${dbFile}.`);
  return db;
}

if (require.main === module) {
  main();
  db.close();
}
module.exports = { run: main };
