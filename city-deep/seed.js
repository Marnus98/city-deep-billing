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

// Client-requested display renames for the Industrial Park section (2026-08-24), giving each
// tenant its correct registered company name plus a proper unit number instead of the informal
// name that came off the source workbook tabs. This is intentionally a SEPARATE map from
// TENANT_NAME_ALIASES above: TENANT_NAME_ALIASES is a create/lookup key used *before* a tenant
// row exists (so two entries that alias to the same value get merged into one row), whereas two
// of these renames deliberately point at the SAME new company name for two different, separately
// metered units (AGRANA Fruit's Unit 2B and Unit 2C) - folding those into TENANT_NAME_ALIASES
// would collapse them into a single tenant record and silently merge their meters/bills on the
// next fresh reseed. So this map is applied as a post-creation UPDATE instead, keyed by each
// tenant's own original workbook name, after every tenant row for the month already exists.
const TENANT_DISPLAY_OVERRIDES = {
  'Kimmo (PTY) LTD - Industrial Park': { name: 'Kimmo (Pty) Ltd', unit: 'Unit 1' },
  'AGRANA Fruit - Industrial Park': { name: 'Agrana Fruit South Africa (Pty) Ltd', unit: 'Unit 2B' },
  'AGRANA Fruit Warehouse/Office - Industrial Park': { name: 'Agrana Fruit South Africa (Pty) Ltd', unit: 'Unit 2C' },
  'Lesco - Industrial Park': { name: 'Lesco Manufacturing (Pty) Ltd', unit: 'Unit 2A' },
  'Unit 3 HUDACO Trading - Industrial Park': { name: 'Hudaco Trading (Pty) Ltd', unit: 'Unit 3' },
  'Unit 4A JC Bakery (PTY) LTD - Industrial Park': { name: 'JC Bakeries (Pty) Ltd', unit: 'Unit 4A' },
  'Unit 4B JC Bakery (PTY) LTD - Industrial Park': { name: 'JC Bakeries (Pty) Ltd', unit: 'Unit 4B' },
  'Unit 5A Skillcraft Agencies - Industrial Park': { name: 'Skillcraft Agencies (Pty) Ltd', unit: 'Unit 5A' },
  'Unit 5B Skillcraft Agencies - Industrial Park': { name: 'Skillcraft Agencies (Pty) Ltd', unit: 'Unit 5B' },
  'Unit 6A&B TERAOKA SA- Industrial Park': { name: 'Teraoka Sa (Pty) Ltd', unit: 'Unit 6A&B' },
  'Unit 6C TERAOKA SA- Industrial Park': { name: 'Teraoka Sa (Pty) Ltd', unit: 'Unit 6C' },
  'Unit 4 ATC SA Wireless Infrastructure (PTY) LTD': { name: 'ATC SA Wireless Infrastructure (Pty) Ltd', unit: 'Unit 6' },

  // Mini Park + Rittle section renames (2026-08-24), same client request extended to the rest of
  // City Deep. Two notes from the client's own mapping table that affect how this is applied:
  //  - There are two distinct DB tenants that both source-workbook-named themselves
  //    "Shop 3 Unit 9 SANSKAR Trading" in the client's table (a copy/paste artefact in their
  //    sheet) - disambiguated here using each DB tenant's OWN embedded unit number: the tenant
  //    whose real name says "Unit 3" is Unit 3, the one whose real name says "Unit 9" is Unit 9.
  //    Both correct to "Sanskar Trading CC".
  //  - Two Mini Park units (4 and 5, Americandy and this section's separate Agrana entity - not
  //    to be confused with the two Industrial Park Agrana units above) are noted as being taken
  //    over by a new tenant "Twinpouch" from 1 Aug 2026. Since tenant name isn't period-specific
  //    in this schema, renaming Americandy/Agrana here would incorrectly relabel their pre-Aug-26
  //    history too - so this only corrects their legal names for the tenancy as it stood, and
  //    Twinpouch itself is deliberately NOT added here (no workbook data exists for them yet -
  //    add it as a new tenant via getOrCreateTenant when the first Twinpouch month is imported).
  //    Same reasoning applies to the Sanskar Unit 9 -> Uber Nutrition handover noted for 1 Sep 26.
  'Unit 1 Network Dynamics (PTY)LTD': { name: 'Network Dynamics (Pty) Ltd', unit: 'Unit 1' },
  'Shop 10 Unit 2 Express Chef Sauces': { name: 'Express Chef Sauces (Pty) Ltd', unit: 'Unit 2 (Shop 10)' },
  'Unit 3 SANSKAR Trading': { name: 'Sanskar Trading CC', unit: 'Unit 3' },
  'Unit 4 Americandy Manufacturers (PTY)LTD': { name: 'Americandy Manufacturers (Pty) Ltd', unit: 'Unit 4' },
  'Unit 5 AGRANA': { name: 'Agrana Fruit South Africa (Pty) Ltd', unit: 'Unit 5' },
  // The two synthetic post-handover tenant identities TENANT_HANDOVERS redirects Unit 4/5 to from
  // 2026-08 onward (see that const's own header comment) - display-overridden the same way as
  // every other raw-workbook-name entry in this map, just keyed by a name that never came off a
  // real workbook tab.
  '__HANDOVER_TWINPOUCH_UNIT4__': { name: 'Twinpouch (Pty) Ltd', unit: 'Unit 4' },
  '__HANDOVER_TWINPOUCH_UNIT5__': { name: 'Twinpouch (Pty) Ltd', unit: 'Unit 5' },
  'Shop 6 Unit 6 URBER Nutrition (PTY) LTD': { name: 'Uber Nutrition (Pty) Ltd', unit: 'Unit 6' },
  'Shop 5 Unit 7 URBER Nutrition (PTY) LTD': { name: 'Uber Nutrition (Pty) Ltd', unit: 'Unit 7' },
  'Shop 4 Unit 8 Citrashine': { name: 'Citrashine (Pty) Ltd', unit: 'Unit 8 (Shop 4)' },
  'Shop 3 Unit 9 SANSKAR Trading': { name: 'Sanskar Trading CC', unit: 'Unit 9' },
  'Unit 10 Berzack Brothers (PYY) Ltd': { name: 'Berzack Brothers (Pty) Ltd', unit: 'Unit 10' },
  'Unit 11 Surplus Grain Traders CC': { name: 'Surplus Grain Traders CC', unit: 'Unit 11' },
  'Shop 2 Growers Connect - Mini Park': { name: 'Growers Connect (Pty) Ltd', unit: 'Shop 2' },
};
function applyTenantDisplayOverrides() {
  for (const [oldName, { name, unit }] of Object.entries(TENANT_DISPLAY_OVERRIDES)) {
    run('UPDATE tenants SET name=?, unit=? WHERE name=?', [name, unit, oldName]);
  }
}

// Mid-history tenant handovers: same physical unit/meters, occupant changed on a specific date -
// from the client's "Tenant Occupancy Changes" mapping table (2026-08-24), applied 2026-08-31 once
// the first period on/after each handover's effective month was actually imported (no point
// redirecting bills to a tenant with zero workbook data behind it). Tenant identity in this schema
// is one continuous DB row matched by raw workbook name (getOrCreateTenant), so a mid-year occupant
// change can't be expressed as a TENANT_DISPLAY_OVERRIDES rename alone without incorrectly
// relabeling the outgoing tenant's own pre-handover history too. Instead, seedMonth() below checks
// this list before resolving a block's tenant: once the billing period's own label reaches
// `fromLabel`, that workbook row's bills/meter-assignments/readings get attached to a brand-new
// synthetic tenant identity (`newRawName`, display-renamed via TENANT_DISPLAY_OVERRIDES above)
// instead of the outgoing tenant - every period before `fromLabel` is completely unaffected, still
// resolving to the original tenant exactly as before. meter_assignments' own effective_from/
// effective_to versioning (see upsertAssignment) then naturally closes out the old tenant's
// assignment on each shared meter as of the handover period's start and opens a new one for the
// incoming tenant - the same mechanism that already handles a tariff or allocation change mid-year,
// just triggered by a tenant_id change instead this time.
//
// Source table had 3 rows; only 2 are listed here. The 3rd (Unit 9, Sanskar Trading CC -> Uber
// Nutrition (Pty) Ltd, effective 2026-09) is client-confirmed but deliberately NOT added yet - no
// billing period with label >= '2026-09' has been imported, so there is nothing for it to redirect.
// Add it here (matching rawName 'Shop 3 Unit 9 SANSKAR Trading', fromLabel '2026-09') once the
// first September 2026 workbook is imported.
const TENANT_HANDOVERS = [
  { rawName: 'Unit 4 Americandy Manufacturers (PTY)LTD', fromLabel: '2026-08', newRawName: '__HANDOVER_TWINPOUCH_UNIT4__' },
  { rawName: 'Unit 5 AGRANA', fromLabel: '2026-08', newRawName: '__HANDOVER_TWINPOUCH_UNIT5__' },
];
function resolveTenantWorkbookName(rawName, periodLabel) {
  const handover = TENANT_HANDOVERS.find((h) => h.rawName === rawName && periodLabel >= h.fromLabel);
  return handover ? handover.newRawName : rawName;
}

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
    // meter_readings.start_reading/end_reading are NOT NULL columns, so a genuinely unusable
    // reading (source workbook cell wasn't a clean number - see august2026.json's own patch note:
    // one meter's Aug 2026 Start/End cells came through as literal text like
    // '(460128.576/769.44)' instead of a reading, a source data-quality issue sanitized to null at
    // extraction time rather than guessed at) simply skips this INSERT instead of storing a false
    // 0. The elecMeters/waterMeters queries (server.js) LEFT JOIN meter_readings, so a meter with
    // no row for this period naturally comes back with start_reading/end_reading = NULL anyway -
    // pdf.js's drawMeterReadingsTable and views.js's lineTable both already render that as '-'
    // rather than a bogus start-minus-end subtraction. The bill's own Consumption total is
    // unaffected either way since it comes from row.consumption_kwh directly, never from end-start.
    if (row.start != null && row.end != null) {
      run(`INSERT OR REPLACE INTO meter_readings
          (meter_id, billing_period_id, start_reading, end_reading, start_reading_kvarh, end_reading_kvarh, kva_reading, source)
          VALUES (?,?,?,?,?,?,?,?)`,
        [meter.id, billingPeriod.id, row.start, row.end, null, null, row.kva || 0, 'excel_import']);
    }

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
    // Same skip-rather-than-fake-a-0 convention as the electricity meter insert above (meter_
    // readings.start_reading/end_reading are NOT NULL columns) - a non-numeric source cell reads
    // as "no reading available" via the LEFT JOIN in server.js's waterMeters query, not a false 0.
    if (row.start != null && row.end != null) {
      run(`INSERT OR REPLACE INTO meter_readings
          (meter_id, billing_period_id, start_reading, end_reading, source)
          VALUES (?,?,?,?,?)`,
        [meter.id, billingPeriod.id, row.start, row.end, 'excel_import']);
    }

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
    // Redirects to a brand-new tenant identity once this period reaches a handover's effective
    // month - see TENANT_HANDOVERS' own header comment. siteForTenantName still runs on the
    // original raw `name` (not the synthetic handover name), since that's what its own regex
    // matching depends on.
    const tenant = getOrCreateTenant(resolveTenantWorkbookName(name, billingPeriod.label), siteForTenantName(name));
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

// All 14 imported months, July 2025 - August 2026. Order here doesn't matter for correctness -
// seedMonth() is re-sorted by each workbook's own period.start date below - because the file
// named "July 2025" turns out to carry an internal period of 30 May - 25 June 2025 (about a month
// behind its filename), which leaves a real, unexplained gap between it and the August 2025
// file's period (25 June - 25 July 2025 is not covered by any workbook supplied). That gap is
// reproduced here rather than guessed at - see README "Known data gaps".
const MONTH_FILES = [
  'july2025.json', 'august2025.json', 'september2025.json', 'october2025.json',
  'november2025.json', 'december2025.json', 'january2026.json', 'february2026.json',
  'march.json', 'april.json', 'may2026.json', 'june2026.json', 'july2026.json',
  'august2026.json',
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
    applyTenantDisplayOverrides();
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
