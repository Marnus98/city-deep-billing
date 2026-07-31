// city-deep/seed.js - imports the parsed monthly workbook JSON (produced by extract.py, one file
// per month under city-deep/imports/) into the SQLite database, computing bills with calc.js as
// it goes, and storing the workbook's own totals in excel_reference for the reconciliation report.
//
// This is City Deep's property-specific seed script (see properties.js). `db` is opened lazily
// inside main(dbFile) rather than at module load time, because the multi-property platform now
// requires('./city-deep/seed') without necessarily wanting City Deep's database opened - only
// run(dbFile) (or `node city-deep/seed.js`, which defaults to City Deep's own file) actually opens
// anything. Shared platform code (db.js, calc.js, shared_seed_users.js) lives one level up at the
// repo root, hence the '../' requires below.
const fs = require('fs');
const path = require('path');
const { open, migrate } = require('../db');
const calc = require('../calc');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');

let db;

function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }

// ---------- Users ----------
// Credentials themselves live in shared_seed_users.js (one place, shared with auth.db and every
// other property's seed script) - this just inserts them into City Deep's own db too, so its
// local audit_log.user_id foreign key has a matching row (see shared_seed_users.js for why).
function seedUsers() {
  if (seedUsersShared(db)) {
    console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');
  }
}

// ---------- Tariffs ----------
function buildTariffParams(tariffRaw) {
  const B = (n) => tariffRaw[`B${n}`] ? tariffRaw[`B${n}`].B : null;
  const tariff1 = {
    serviceCharge: B(5), energyRate: B(9), demandKva: B(3), demandKvarh: B(4), surchargePct: B(8),
  };
  const tariff2 = {
    serviceCharge: B(20), capacityCharge: B(21),
    blocks: [
      { upTo: 500, rate: B(14) }, { upTo: 1000, rate: B(15) }, { upTo: 2000, rate: B(16) },
      { upTo: 3000, rate: B(17) }, { upTo: Infinity, rate: B(18) },
    ],
    surchargePct: B(22), networkLevy: B(25), businessSurchargePct: B(26),
  };
  const water = {
    tier1Limit: 200, tier1Rate: B(28), tier2Rate: B(29), surchargePct: 0.02,
    sanitationRate: B(31), sanitationSurchargePct: 0.02, waterLevyBase: 322.97,
  };
  return { tariff1, tariff2, water };
}

function seedTariffsAndPeriod(monthData) {
  const { period, tariff_raw, label } = monthData;
  const params = buildTariffParams(tariff_raw);

  let bp = get('SELECT * FROM billing_periods WHERE label = ?', [label]);
  if (!bp) {
    run('INSERT INTO billing_periods (label, start_date, end_date, invoice_date, due_date) VALUES (?,?,?,?,?)',
      [label, period.start, period.end, period.end, period.end]);
    bp = get('SELECT * FROM billing_periods WHERE label = ?', [label]);
  }

  const tariffDefs = [
    ['electricity', 1, 'Electrical (flat + demand)', params.tariff1],
    ['electricity', 2, 'Electrical Step Tariff (Business Conventional)', params.tariff2],
    ['water', null, 'Water / Sanitation', params.water],
  ];
  const tariffIds = {};
  for (const [utility, code, name, p] of tariffDefs) {
    let t = get('SELECT * FROM tariffs WHERE utility_type=? AND (code IS ? )', [utility, code]);
    if (!t) {
      run('INSERT INTO tariffs (utility_type, code, name) VALUES (?,?,?)', [utility, code, name]);
      t = get('SELECT * FROM tariffs WHERE utility_type=? AND (code IS ?)', [utility, code]);
    }
    // Close any open version, open a new one dated to this period (values happen to be identical
    // March->April in the source data, but this proves the versioning mechanism works).
    const openVersion = get('SELECT * FROM tariff_versions WHERE tariff_id=? AND effective_to IS NULL', [t.id]);
    const json = JSON.stringify(p);
    if (!openVersion || openVersion.params_json !== json) {
      if (openVersion) run('UPDATE tariff_versions SET effective_to=? WHERE id=?', [period.start, openVersion.id]);
      run('INSERT INTO tariff_versions (tariff_id, effective_from, effective_to, params_json, vat_rate) VALUES (?,?,?,?,?)',
        [t.id, period.start, null, json, 0.15]);
    }
    tariffIds[utility + (code || '')] = t.id;
  }
  return { billingPeriod: bp, params };
}

// The Electrical Billing and Water Billing sheets spell a handful of tenant names slightly
// differently (typos / inconsistent abbreviations). Without this alias map the importer would
// create two separate tenant records for the same real tenant. This is a documented Phase-1
// data-quality finding, not something invented here.
const TENANT_NAME_ALIASES = {
  'AGRANA Fruit Office and Warehouse - Industrial Park': 'AGRANA Fruit Warehouse/Office - Industrial Park',
  'Shop 3 Unit 9 SANSKAR Teading': 'Shop 3 Unit 9 SANSKAR Trading',
  'Unit 10 Berzack Brothers (PTY)LTD T/A Bloch & Levitan': 'Unit 10 Berzack Brothers (PYY) Ltd',
  'Unit 3 Bitzer Kuhlmaschinenbau SA (PTY)LTD': 'Unit 3 Bitzer Kuhlmaschinenba U SA (PTY)LTD',
};
function canonicalTenantName(name) { return TENANT_NAME_ALIASES[name] || name; }

// ---------- Tenants / Meters / Assignments ----------
function getOrCreateTenant(name, siteName) {
  name = canonicalTenantName(name);
  let site = get('SELECT * FROM sites WHERE name=?', [siteName]);
  if (!site) { run('INSERT INTO sites (name) VALUES (?)', [siteName]); site = get('SELECT * FROM sites WHERE name=?', [siteName]); }
  let tenant = get('SELECT * FROM tenants WHERE name=?', [name]);
  if (!tenant) {
    run('INSERT INTO tenants (site_id, name, unit, status) VALUES (?,?,?,?)', [site.id, name, null, 'active']);
    tenant = get('SELECT * FROM tenants WHERE name=?', [name]);
  }
  return tenant;
}

// unitScale is the meter's billing multiplier (CT ratio) - some electricity meters read a
// fraction of true consumption off the dial and need multiplying to get real kWh (confirmed
// against the 'Elect Readings' sheet's own 'Billing Mult' column: 14 meters in April 2026 alone
// have a multiplier other than 1, up to x260). The Electrical Billing sheet's own start/end/
// consumption columns already have this baked in for historical months (seed.js passes Excel's
// own consumption_kwh straight through, never recomputes end-start itself), so this only matters
// for the *new* manual reading-capture flow (billing.js), which does compute end-start itself and
// needs to know the multiplier to get real kWh from what a user types in off the meter dial.
function getOrCreateMeter(serial, utilityType, role, location, unitScale) {
  let m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  if (!m) {
    run('INSERT INTO meters (serial, utility_type, role, location, unit_scale) VALUES (?,?,?,?,?)',
      [serial, utilityType, role, location, unitScale || 1]);
    m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  } else if (unitScale && Math.abs((m.unit_scale ?? 1) - unitScale) > 1e-9) {
    run('UPDATE meters SET unit_scale=? WHERE id=?', [unitScale, m.id]);
    m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  }
  return m;
}

function upsertAssignment({ meterId, tenantId, tariffCode, serviceFlag, sign, allocationPct, kvarhAllocationPct, kvaAllocationPct, capacityChargeOverride, carriesLevy, isCommonArea, energyOnly, periodStart }) {
  const open = get(
    'SELECT * FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL ORDER BY id DESC LIMIT 1',
    [meterId]
  );
  const near = (a, b) => Math.abs((a == null ? 0 : a) - (b == null ? 0 : b)) < 1e-6;
  const same = open && open.tenant_id === tenantId && open.tariff_code === tariffCode &&
    open.service_charge_flag === (serviceFlag ? 1 : 0) && open.sign === sign &&
    near(open.allocation_pct, allocationPct) && near(open.allocation_pct_kvarh, kvarhAllocationPct) &&
    near(open.allocation_pct_kva, kvaAllocationPct) && near(open.capacity_charge_override, capacityChargeOverride) &&
    open.carries_network_levy === (carriesLevy ? 1 : 0) && open.energy_only === (energyOnly ? 1 : 0);
  if (same) return open;
  if (open) run('UPDATE meter_assignments SET effective_to=? WHERE id=?', [periodStart, open.id]);
  run(`INSERT INTO meter_assignments
      (meter_id, tenant_id, tariff_code, service_charge_flag, sign, allocation_pct, allocation_pct_kvarh, allocation_pct_kva, capacity_charge_override, carries_network_levy, is_common_area, energy_only, effective_from)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [meterId, tenantId, tariffCode, serviceFlag ? 1 : 0, sign, allocationPct, kvarhAllocationPct ?? null, kvaAllocationPct ?? null,
     capacityChargeOverride ?? null, carriesLevy ? 1 : 0, isCommonArea ? 1 : 0, energyOnly ? 1 : 0, periodStart]);
  return get('SELECT * FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL', [meterId]);
}

// Detects rows where the source workbook hand-overrode the fixed-charge/surcharge formulas to 0
// (K/service flag says charges should apply, but the cached formula results are all zero anyway).
function detectEnergyOnly(row) {
  return !!row.service_flag && row.service_charge === 0 && row.capacity_charge === 0 &&
    row.network_surcharge === 0 && row.business_surcharge === 0;
}

// Detects a fixed capacity charge that doesn't match the standard tariff rate - confirmed as a
// genuine per-tenant negotiated rate (Unit 4 ATC SA Wireless Infrastructure: flat R661.90/month
// in all 12 imported months regardless of the standard rate changing), not a data error.
function detectCapacityChargeOverride(row, tariff2) {
  if (row.tariff_code !== 2 || !row.service_flag || tariff2.capacityCharge == null) return null;
  const standard = tariff2.capacityCharge * (row.sign || 1);
  const actual = row.capacity_charge || 0;
  if (Math.abs(actual - standard) < 0.5) return null;
  return row.sign ? actual / row.sign : actual;
}

function allocationFromRow(rawConsumption, billable, commonAreaPct) {
  if (rawConsumption && Math.abs(rawConsumption) > 1e-9) return billable / rawConsumption;
  if (commonAreaPct != null) return commonAreaPct;
  return 1;
}

function siteForTenantName(name) {
  if (/Mini Park|Shop \d/i.test(name)) return 'Mini Park';
  if (/Industrial Park/i.test(name)) return 'Industrial Park';
  if (/^Unit/i.test(name)) return 'Mini Park';
  return 'City Deep';
}

// ---------- Bill generation ----------
function generateBill(tenant, billingPeriod, elecMeterRows, waterMeterRows, tariffParams, precinctYEnabled, unitScaleBySerial) {
  const lineItems = [];
  let elecKwhTotal = 0, waterM3Total = 0;

  for (const row of elecMeterRows) {
    const unitScale = (unitScaleBySerial && unitScaleBySerial[row.serial]) || 1;
    const meter = getOrCreateMeter(row.serial, 'electricity', row.common_area_pct != null ? 'common_area' : 'tenant', row.location, unitScale);
    // store reading
    run(`INSERT OR REPLACE INTO meter_readings
        (meter_id, billing_period_id, start_reading, end_reading, start_reading_kvarh, end_reading_kvarh, kva_reading, source)
        VALUES (?,?,?,?,?,?,?,?)`,
      [meter.id, billingPeriod.id, row.start || 0, row.end || 0, null, null, row.kva || 0, 'excel_import']);

    const allocationPct = allocationFromRow(row.consumption_kwh, row.billable_consumption, row.common_area_pct);
    const kvarhAlloc = allocationFromRow(row.kvarh, row.billable_kvarh, row.common_area_pct);
    const kvaAlloc = allocationFromRow(row.kva, row.billable_kva, row.common_area_pct);

    const energyOnly = detectEnergyOnly(row);
    const capacityChargeOverride = detectCapacityChargeOverride(row, tariffParams.tariff2);
    const assignment = upsertAssignment({
      meterId: meter.id, tenantId: tenant.id, tariffCode: row.tariff_code, serviceFlag: row.service_flag,
      sign: row.sign, allocationPct, kvarhAllocationPct: kvarhAlloc, kvaAllocationPct: kvaAlloc, capacityChargeOverride,
      carriesLevy: !!row.network_levy, isCommonArea: row.common_area_pct != null,
      energyOnly, periodStart: billingPeriod.start_date,
    });

    const result = calc.calcElectricityMeterLine({
      rawConsumptionKwh: row.consumption_kwh, rawKvarh: row.kvarh, rawKva: row.kva,
      allocationPct, kvarhAllocationPct: kvarhAlloc, kvaAllocationPct: kvaAlloc,
      tariffCode: row.tariff_code, serviceChargeFlag: !!row.service_flag, sign: row.sign,
      carriesNetworkLevy: !!row.network_levy, isCommonArea: row.common_area_pct != null, energyOnly, capacityChargeOverride,
      tariff1: tariffParams.tariff1, tariff2: tariffParams.tariff2, yChargeEnabled: precinctYEnabled,
    });
    for (const li of result.lineItems) lineItems.push({ ...li, meter_id: meter.id, utility_type: 'electricity' });
    elecKwhTotal += (row.consumption_kwh || 0) * row.sign * allocationPct;
  }

  for (const row of waterMeterRows) {
    const meter = getOrCreateMeter(row.serial, 'water', row.common_area_pct != null ? 'common_area' : 'tenant', null);
    run(`INSERT OR REPLACE INTO meter_readings
        (meter_id, billing_period_id, start_reading, end_reading, source)
        VALUES (?,?,?,?,?)`,
      [meter.id, billingPeriod.id, row.start || 0, row.end || 0, 'excel_import']);

    const allocationPct = allocationFromRow(row.consumption_m3, row.billable_consumption, row.common_area_pct);
    upsertAssignment({
      meterId: meter.id, tenantId: tenant.id, tariffCode: null, serviceFlag: true, sign: 1,
      allocationPct, carriesLevy: !!row.water_levy, isCommonArea: row.common_area_pct != null,
      periodStart: billingPeriod.start_date,
    });

    const result = calc.calcWaterMeterLine({
      rawConsumptionM3: row.consumption_m3, allocationPct, waterTariff: tariffParams.water,
      isCommonArea: row.common_area_pct != null,
    });
    for (const li of result.lineItems) lineItems.push({ ...li, meter_id: meter.id, utility_type: 'water' });
    if (row.water_levy) {
      lineItems.push({ category: 'water_levy', description: 'Water levy (common area)', quantity: null, rate: null, amount: calc.round2(row.water_levy), meter_id: meter.id, utility_type: 'water' });
    }
    waterM3Total += (row.consumption_m3 || 0) * allocationPct;
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
    [tenant.id, billingPeriod.id, 'finalised', subtotal, vatRate, vatAmount, total, calc.round2(elecKwhTotal), calc.round2(waterM3Total),
     `CD-${billingPeriod.label}-${tenant.id}`]);
  const bill = get('SELECT * FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, billingPeriod.id]);
  for (const li of lineItems) {
    run('INSERT INTO bill_line_items (bill_id, meter_id, utility_type, category, description, quantity, rate, amount) VALUES (?,?,?,?,?,?,?,?)',
      [bill.id, li.meter_id, li.utility_type, li.category, li.description, li.quantity, li.rate, li.amount]);
  }
  return { bill, subtotal, elecKwhTotal, waterM3Total };
}

// These 4 mini-substation "bulk export" meters aren't billed to any single tenant, so they never
// go through generateBill()/calc.js and never get a meters/meter_readings row from the main import
// loop. The new "Solar Billing Slips" report (solar.js) needs their raw readings directly (they
// represent how much a whole mini-sub exported back to the grid), so import them here as
// role='bulk' meters purely for that report to read - they carry no tenant assignment and never
// appear on any bill.
const SOLAR_BULK_EXPORT_METERS = [
  { serial: '35726713E', label: 'Bulk Meter Mini Sub D (feeds JC Bakery)' },
  { serial: '35775954E', label: 'Mini Sub B Bulk Meter (feeds Lesco/Agrana)' },
  { serial: '35776118E', label: 'Bulk Mini Sub E (feeds SkillCraft)' },
  { serial: '36533986E', label: 'Bulk Meter Mini Sub F (feeds Teraoka SA)' },
];
function seedSolarBulkMeters(monthData, billingPeriod) {
  for (const cfg of SOLAR_BULK_EXPORT_METERS) {
    const row = (monthData.elect_readings || []).find((r) => r.serial === cfg.serial);
    if (!row) continue; // not present in this month's workbook - skip, don't break the rest of the import
    const meter = getOrCreateMeter(cfg.serial, 'electricity', 'bulk', row.location || cfg.label, row.billing_mult || 1);
    run(`INSERT OR REPLACE INTO meter_readings
        (meter_id, billing_period_id, start_reading, end_reading, source)
        VALUES (?,?,?,?,?)`,
      [meter.id, billingPeriod.id, row.start_kwh || 0, row.end_kwh || 0, 'excel_import']);
  }
}

function seedMonth(monthData) {
  const { billingPeriod, params } = seedTariffsAndPeriod(monthData);
  const elecTenantsByName = {};
  for (const t of monthData.electrical_billing) elecTenantsByName[canonicalTenantName(t.name)] = t;
  const waterTenantsByName = {};
  for (const t of monthData.water_billing) waterTenantsByName[canonicalTenantName(t.name)] = t;

  // Per-meter billing multiplier (CT ratio), read off the 'Elect Readings' sheet's own 'Billing
  // Mult' column for this month - see getOrCreateMeter for why this matters.
  const unitScaleBySerial = {};
  for (const r of monthData.elect_readings || []) {
    if (r.serial != null && typeof r.billing_mult === 'number') unitScaleBySerial[r.serial] = r.billing_mult;
  }

  const allNames = new Set([...Object.keys(elecTenantsByName), ...Object.keys(waterTenantsByName)]);
  let count = 0;
  for (const name of allNames) {
    const tenant = getOrCreateTenant(name, siteForTenantName(name));
    const elecBlock = elecTenantsByName[name];
    const waterBlock = waterTenantsByName[name];
    // The kVArh demand charge (column Y) only has a working formula in the "Mini Park" precinct's
    // section of the Electrical Billing sheet, not "Industrial Park" (confirmed Phase 1 finding).
    // This used to be detected by a hardcoded row-number cutoff tuned to March/April's specific
    // row layout, which silently breaks on any month where tenants were added/removed (the
    // precinct boundary moves row-for-row with the roster). Site name is the actual business
    // rule and is stable across every month.
    const precinctYEnabled = siteForTenantName(name) === 'Mini Park';
    const { bill, subtotal } = generateBill(
      tenant, billingPeriod,
      elecBlock ? elecBlock.meters : [],
      waterBlock ? waterBlock.meters : [],
      params, precinctYEnabled, unitScaleBySerial
    );
    // Excel reference totals for reconciliation
    if (elecBlock && elecBlock.totals) {
      run(`INSERT OR REPLACE INTO excel_reference (tenant_id, billing_period_id, utility_type, consumption, charge_total_excl_vat)
           VALUES (?,?,?,?,?)`,
        [tenant.id, billingPeriod.id, 'electricity',
         elecBlock.meters.reduce((s, m) => s + (m.consumption_kwh || 0) * (m.sign || 1), 0),
         elecBlock.totals.row_total]);
    }
    if (waterBlock && waterBlock.totals) {
      run(`INSERT OR REPLACE INTO excel_reference (tenant_id, billing_period_id, utility_type, consumption, charge_total_excl_vat)
           VALUES (?,?,?,?,?)`,
        [tenant.id, billingPeriod.id, 'water',
         waterBlock.meters.reduce((s, m) => s + (m.consumption_m3 || 0), 0),
         waterBlock.totals.row_total]);
    }
    count++;
  }
  seedSolarBulkMeters(monthData, billingPeriod);
  console.log(`Seeded ${count} tenants for period ${monthData.label} (${billingPeriod.start_date} - ${billingPeriod.end_date})`);
}

// All 13 imported months, July 2025 - July 2026. Order here doesn't matter for correctness -
// seedMonth() is re-sorted by each workbook's own period.start date below - because the file
// named "July 2025" turns out to carry an internal period of 30 May - 25 June 2025 (about a month
// behind its filename), which leaves a real, unexplained gap between it and the August 2025
// file's period (25 June - 25 July 2025 is not covered by any workbook supplied). That gap is
// reproduced here rather than guessed at - see README "Known data gaps".
const MONTH_FILES = [
  'july2025.json', 'august2025.json', 'september2025.json', 'october2025.json',
  'november2025.json', 'december2025.json', 'january2026.json', 'february2026.json',
  'march.json', 'april.json', 'may2026.json', 'june2026.json', 'july2026.json',
];

// `dbFile` picks which property database this seeds (see properties.js) - defaults to City
// Deep's own file so `node seed.js` with no arguments still works exactly as before.
function main(dbFile = 'city-deep.db') {
  db = open(dbFile);
  migrate(db);
  const months = MONTH_FILES
    .map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'imports', f), 'utf8')))
    .sort((a, b) => a.period.start.localeCompare(b.period.start));
  // Each seedUsers()/seedMonth() call is many small INSERT/UPDATE statements; run the whole
  // import as one transaction instead of auto-committing every statement individually - orders
  // of magnitude faster (this matters because seeding runs synchronously on server boot on hosts
  // with an ephemeral filesystem, e.g. Render's free tier, before the port opens).
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

// Allow `require('./seed').run(dbFile)` from server.js for auto-seed-on-first-boot (handy on
// hosts with an ephemeral filesystem, e.g. a free-tier deploy with no persistent disk attached),
// as well as `node seed.js` for a manual/standalone run.
if (require.main === module) {
  main();
  db.close();
}
module.exports = { run: main };
