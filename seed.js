// seed.js - imports the parsed March/April workbook JSON (produced by extract.py) into the
// SQLite database, computing bills with calc.js as it goes, and storing the workbook's own
// totals in excel_reference for the reconciliation report.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, migrate } = require('./db');
const calc = require('./calc');

const db = open();
migrate(db);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }

// ---------- Users ----------
function seedUsers() {
  const existing = get('SELECT COUNT(*) c FROM users').c;
  if (existing > 0) return;
  const users = [
    ['admin', 'admin123', 'admin', 'System Administrator'],
    ['billing', 'billing123', 'billing', 'Billing Clerk'],
    ['reviewer', 'reviewer123', 'reviewer', 'Billing Reviewer'],
    ['viewer', 'viewer123', 'readonly', 'Read Only User'],
  ];
  for (const [username, pw, role, full_name] of users) {
    const { salt, hash } = hashPassword(pw);
    run('INSERT INTO users (username, password_hash, salt, role, full_name) VALUES (?,?,?,?,?)',
      [username, hash, salt, role, full_name]);
  }
  console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');
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

function getOrCreateMeter(serial, utilityType, role, location) {
  let m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  if (!m) {
    run('INSERT INTO meters (serial, utility_type, role, location) VALUES (?,?,?,?)', [serial, utilityType, role, location]);
    m = get('SELECT * FROM meters WHERE serial=?', [serial]);
  }
  return m;
}

function upsertAssignment({ meterId, tenantId, tariffCode, serviceFlag, sign, allocationPct, carriesLevy, isCommonArea, energyOnly, periodStart }) {
  const open = get(
    'SELECT * FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL ORDER BY id DESC LIMIT 1',
    [meterId]
  );
  const same = open && open.tenant_id === tenantId && open.tariff_code === tariffCode &&
    open.service_charge_flag === (serviceFlag ? 1 : 0) && open.sign === sign &&
    Math.abs(open.allocation_pct - allocationPct) < 1e-6 && open.carries_network_levy === (carriesLevy ? 1 : 0) &&
    open.energy_only === (energyOnly ? 1 : 0);
  if (same) return open;
  if (open) run('UPDATE meter_assignments SET effective_to=? WHERE id=?', [periodStart, open.id]);
  run(`INSERT INTO meter_assignments
      (meter_id, tenant_id, tariff_code, service_charge_flag, sign, allocation_pct, carries_network_levy, is_common_area, energy_only, effective_from)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [meterId, tenantId, tariffCode, serviceFlag ? 1 : 0, sign, allocationPct, carriesLevy ? 1 : 0, isCommonArea ? 1 : 0, energyOnly ? 1 : 0, periodStart]);
  return get('SELECT * FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL', [meterId]);
}

// Detects rows where the source workbook hand-overrode the fixed-charge/surcharge formulas to 0
// (K/service flag says charges should apply, but the cached formula results are all zero anyway).
function detectEnergyOnly(row) {
  return !!row.service_flag && row.service_charge === 0 && row.capacity_charge === 0 &&
    row.network_surcharge === 0 && row.business_surcharge === 0;
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
function generateBill(tenant, billingPeriod, elecMeterRows, waterMeterRows, tariffParams, precinctYEnabled) {
  const lineItems = [];
  let elecKwhTotal = 0, waterM3Total = 0;

  for (const row of elecMeterRows) {
    const meter = getOrCreateMeter(row.serial, 'electricity', row.common_area_pct != null ? 'common_area' : 'tenant', row.location);
    // store reading
    run(`INSERT OR REPLACE INTO meter_readings
        (meter_id, billing_period_id, start_reading, end_reading, start_reading_kvarh, end_reading_kvarh, kva_reading, source)
        VALUES (?,?,?,?,?,?,?,?)`,
      [meter.id, billingPeriod.id, row.start || 0, row.end || 0, null, null, row.kva || 0, 'excel_import']);

    const allocationPct = allocationFromRow(row.consumption_kwh, row.billable_consumption, row.common_area_pct);
    const kvarhAlloc = allocationFromRow(row.kvarh, row.billable_kvarh, row.common_area_pct);
    const kvaAlloc = allocationFromRow(row.kva, row.billable_kva, row.common_area_pct);

    const energyOnly = detectEnergyOnly(row);
    const assignment = upsertAssignment({
      meterId: meter.id, tenantId: tenant.id, tariffCode: row.tariff_code, serviceFlag: row.service_flag,
      sign: row.sign, allocationPct, carriesLevy: !!row.network_levy, isCommonArea: row.common_area_pct != null,
      energyOnly, periodStart: billingPeriod.start_date,
    });

    const result = calc.calcElectricityMeterLine({
      rawConsumptionKwh: row.consumption_kwh, rawKvarh: row.kvarh, rawKva: row.kva,
      allocationPct, kvarhAllocationPct: kvarhAlloc, kvaAllocationPct: kvaAlloc,
      tariffCode: row.tariff_code, serviceChargeFlag: !!row.service_flag, sign: row.sign,
      carriesNetworkLevy: !!row.network_levy, isCommonArea: row.common_area_pct != null, energyOnly,
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

function seedMonth(monthData) {
  const { billingPeriod, params } = seedTariffsAndPeriod(monthData);
  const elecTenantsByName = {};
  for (const t of monthData.electrical_billing) elecTenantsByName[canonicalTenantName(t.name)] = t;
  const waterTenantsByName = {};
  for (const t of monthData.water_billing) waterTenantsByName[canonicalTenantName(t.name)] = t;

  const allNames = new Set([...Object.keys(elecTenantsByName), ...Object.keys(waterTenantsByName)]);
  let count = 0;
  for (const name of allNames) {
    const tenant = getOrCreateTenant(name, siteForTenantName(name));
    const elecBlock = elecTenantsByName[name];
    const waterBlock = waterTenantsByName[name];
    const precinctYEnabled = elecBlock ? elecBlock.header_row >= 96 : true; // Mini Park section >= row 96 has working Y formula
    const { bill, subtotal } = generateBill(
      tenant, billingPeriod,
      elecBlock ? elecBlock.meters : [],
      waterBlock ? waterBlock.meters : [],
      params, precinctYEnabled
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
  console.log(`Seeded ${count} tenants for period ${monthData.label} (${billingPeriod.start_date} - ${billingPeriod.end_date})`);
}

function main() {
  seedUsers();
  const march = JSON.parse(fs.readFileSync(path.join(__dirname, 'march.json'), 'utf8'));
  const april = JSON.parse(fs.readFileSync(path.join(__dirname, 'april.json'), 'utf8'));
  seedMonth(march);
  seedMonth(april);
  console.log('Seed complete.');
}

// Allow `require('./seed').run(db)` from server.js for auto-seed-on-first-boot (handy on hosts
// with an ephemeral filesystem, e.g. a free-tier deploy with no persistent disk attached), as
// well as `node seed.js` for a manual/standalone run.
if (require.main === module) {
  main();
  db.close();
}
module.exports = { run: main };
