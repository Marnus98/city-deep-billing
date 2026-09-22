// recharge_export.js - monthly "recharge CSV" export for the client's accounting system.
//
// Every month the client currently hand-types 3 columns (F=period end date, G=period start date,
// I=Rand amount excl VAT) into two fixed-shape CSV files - "CSV BEV" (AutoZone + Wingfield tenants)
// and "CSV Lisa" (every other property's tenants) - onto a template of otherwise-static rows
// (Building Code / flag / Tenant Code x2 / Utility Code / ... / "Elec period") that never changes
// shape month to month. This module reproduces that exact row template and fills in F/G/I live from
// this app's own already-computed billing data for a given billing_periods/site_billing_slips
// `label` (e.g. '2026-08'), so the client can just download both files instead of retyping numbers.
//
// The row template (ROWS below) was built by cross-referencing the client's own uploaded
// "Tenant_Building_Codes.xlsx" code list against the two real CSV files they've been maintaining by
// hand, AND the live tenant/meter data in every property's own database - see the extensive
// discussion with the client (2026-09-21) for exactly how each row was resolved, including 3
// decisions the client made explicitly:
//   1. Wingfield's "The Core Computer Business" (tenant code 151) - the client's existing template
//      had 3 EL00 rows (one per electricity meter), but the tenant now has 5 real meters (2 new
//      "Lear Security Meter" ones added since July 2026). Client chose to expand to 5 EL00 rows
//      (see CORE_COMPUTER_BUSINESS_METERS below) rather than staying at 3 or collapsing to 1 total.
//   2. City Deep's EL01 "Solar Credit" row - only 4 of the app's 7 solar-linked tenants (Agrana,
//      Lesco, Hudaco, Teraoka) get one, exactly matching the client's existing template. Client
//      confirmed to keep it that way (not add EL01 for Kimmo/Skillcraft/JC Bakery too). Valued as
//      that tenant's net "Solar Used" Rand figure from solar.js's Solar Billing Slips report, shown
//      as a negative credit (reduces the amount owed).
//   3. "IHS Towers" (Wingfield tenant code 158) doesn't exist under that name in the app's Wingfield
//      data (checked all 19 real tenant names) - client confirmed this code is actually "MTN".
//
// Two things could NOT be resolved and are deliberately left as documented gaps rather than guessed:
//   - CSV BEV's tenant-code-269 row has TenantCode2 (column D) = 193 instead of 269 in the client's
//     own original file (193 is Cards Plus's code, a different tenant) - almost certainly a
//     copy/paste slip in the client's own template. Reproduced literally (D=193) since the client
//     hasn't asked for it to be corrected and the export's job is to fill in F/G/I only, not silently
//     rewrite a column that isn't F/G/I.
//   - CSV Lisa's tenant-code-223350 row ("Uber Nutrition - Unit 9" per the xlsx) has no live tenant
//     in city-deep.db yet - city-deep/seed.js documents a confirmed-but-not-yet-implemented handover
//     from Sanskar Trading CC (tenant id 17, currently billed under code 223341) to Uber Nutrition,
//     effective 2026-09, but no billing period >= 2026-09 has been seeded yet. This row always
//     resolves to 0 with a flag until that handover is implemented and a 2026-09+ period exists.
const calcFlatSite = require('./calc_flat_site');
const solar = require('./solar');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

function round2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

// 'YYYY-MM-DD' -> 'DD/MM/YYYY' (the client's own template's date format). Returns '' if missing.
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

// Plain numeric string, no forced trailing zeros and no thousands separator - matches the client's
// own file exactly (e.g. "47890" and "305501.53" side by side in the same column).
function fmtAmount(n) {
  return String(round2(n));
}

// ---------------- flat_site properties (whole-site billing, one client per site) ----------------
// Reads site_billing_slips (the client-facing bill, NOT the municipal statement) for the given
// label, same table flat_site_recovery.js's siteSideFor() reads. Returns null if no slip exists yet
// for this label (e.g. a month not yet billed).
function flatSiteFigures(db, label) {
  const slip = get(db, 'SELECT * FROM site_billing_slips WHERE label=?', [label]);
  if (!slip) return null;
  const tariff = get(db, 'SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
  const items = all(db, 'SELECT * FROM site_tariff_items WHERE tariff_id=? ORDER BY sort_order', [slip.tariff_id]);
  const readingRows = all(db, 'SELECT * FROM site_slip_readings WHERE slip_id=?', [slip.id]);
  const readings = {}; for (const r of readingRows) readings[r.item_key] = { reading: r.reading, comment: r.comment };
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  const waterItem = calc.waterItems.find((i) => i.key === 'water');
  const sewerItem = calc.waterItems.find((i) => i.key === 'sewer');
  // zelvio-global.db / adh-machine-tool.db split tenant vs common-area water/sewer into 4 separate
  // items instead of 2 (water/water_common_area/sewer/sewer_common_area) - folded together here
  // since the client's own template has no separate "common area" utility code, just one WT00/SE00
  // per site, and the common-area portion is still genuinely billed to this same single tenant.
  const waterCommonItem = calc.waterItems.find((i) => i.key === 'water_common_area');
  const sewerCommonItem = calc.waterItems.find((i) => i.key === 'sewer_common_area');
  return {
    elecTotal: calc.elecTotal,
    waterTotal: round2((waterItem ? waterItem.cost : 0) + (waterCommonItem ? waterCommonItem.cost : 0)),
    sewerTotal: round2((sewerItem ? sewerItem.cost : 0) + (sewerCommonItem ? sewerCommonItem.cost : 0)),
    startDate: slip.start_date, endDate: slip.end_date,
  };
}

// ---------------- tenant-model properties (City Deep, Wingfield) ----------------
// Per-property category -> utility-code bucket (see server.js research: category strings differ
// between the two properties' calc engines even though the concepts are the same).
const CATEGORY_BUCKETS = {
  // City Deep's own recharge template (see file header) has no separate SE00 row per tenant, so
  // rather than silently dropping sanitation charges from the monthly recharge, WT00 here is defined
  // as water+sewer COMBINED (client instruction, 2026-09-22: "do the total of what WT00 and SE00
  // would have been together under the WT00 utility code for City deep only"). SE00 is left defined
  // below (harmless, and useful if a City Deep row ever needs the sewer-only figure directly) but no
  // ROWS entry uses it for City Deep - Wingfield's WT00/SE00 stay genuinely split as before.
  'city-deep': {
    EL00: { utility_type: 'electricity' }, // every electricity category rolls up here
    WT00: { categories: ['water_charge', 'water_surcharge', 'water_levy', 'sanitation', 'sanitation_surcharge'] },
    SE00: { categories: ['sanitation', 'sanitation_surcharge'] },
  },
  wingfield: {
    EL00: { utility_type: 'electricity' },
    WT00: { categories: ['water_charge'] },
    SE00: { categories: ['sanitation_charge'] },
  },
};

function billLineItemsTotal(db, tenantId, periodId, bucket) {
  const bill = get(db, 'SELECT id FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenantId, periodId]);
  if (!bill) return 0;
  let rows;
  if (bucket.utility_type) {
    rows = all(db, 'SELECT amount FROM bill_line_items WHERE bill_id=? AND utility_type=?', [bill.id, bucket.utility_type]);
  } else {
    const placeholders = bucket.categories.map(() => '?').join(',');
    rows = all(db, `SELECT amount FROM bill_line_items WHERE bill_id=? AND category IN (${placeholders})`, [bill.id, ...bucket.categories]);
  }
  return round2(rows.reduce((s, r) => s + r.amount, 0));
}

// Sums a utility-code bucket across every tenant row whose name matches one of `tenantNames` (more
// than one when several DB tenant rows/units are meant to combine into a single external code - e.g.
// Agrana's 2 Industrial Park units, Skillcraft's 5A/5B, Teraoka's 6A&B/6C, Uber Nutrition's Unit
// 6+7, Twinpouch's Unit 4+5 - see the client's own Tenant_Building_Codes.xlsx, which lists each of
// these as ONE tenant code covering multiple physical units).
function tenantModelAmount(db, propSlug, tenantNames, periodId, utilityCode) {
  const bucket = CATEGORY_BUCKETS[propSlug][utilityCode];
  const tenants = all(db, `SELECT id FROM tenants WHERE name IN (${tenantNames.map(() => '?').join(',')})`, tenantNames);
  return round2(tenants.reduce((s, t) => s + billLineItemsTotal(db, t.id, periodId, bucket), 0));
}

// The Core Computer Business (Wingfield tenant id 2, code 151) - client chose to break EL00 out
// per-meter rather than as one combined total (see file header note #1). Only electricity is
// per-meter; its WT00/SE00 rows stay as a normal tenant-level total (tenantModelAmount above).
const CORE_COMPUTER_BUSINESS_METERS = [
  'ELON087017', 'ELON087220', 'ELON087086', 'Lear Security Meter Entrance', 'Lear Security Meter Exit',
];
function coreComputerBusinessMeterAmount(db, periodId, serial) {
  const tenant = get(db, "SELECT id FROM tenants WHERE name='The Core Computer Business'");
  if (!tenant) return 0;
  const bill = get(db, 'SELECT id FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, periodId]);
  if (!bill) return 0;
  const rows = all(db, `
    SELECT bli.amount FROM bill_line_items bli
    JOIN meters m ON m.id = bli.meter_id
    WHERE bli.bill_id=? AND m.serial=? AND bli.category IN ('basic_charge','capacity_charge','energy_charge')
  `, [bill.id, serial]);
  return round2(rows.reduce((s, r) => s + r.amount, 0));
}

function billingPeriod(db, label) {
  return get(db, 'SELECT * FROM billing_periods WHERE label=?', [label]);
}

// EL01 "Solar Credit" - net solar-used Rand value from the same Solar Billing Slips report shown on
// screen (solar.js), as a negative credit. Only ever called for the 4 tenants the client confirmed
// (agrana/lesco/hudaco/teraoka) - see file header note #2.
function solarCreditAmount(cityDeepDb, periodId, solarKey) {
  const slips = solar.getSolarSlips(cityDeepDb, periodId);
  const slip = slips.find((s) => s.key === solarKey);
  if (!slip) return 0;
  return round2(-slip.total.solarUsed.rand);
}

// ---------------- the row template ----------------
// file: 'BEV' | 'LISA'. src describes how to compute the amount:
//   { kind:'flat_site', slug, part:'elec'|'water'|'sewer' }
//   { kind:'tenant', slug:'city-deep'|'wingfield', names:[...], utilityCode }
//   { kind:'core_meter', serial }
//   { kind:'solar_credit', solarKey }
//   { kind:'unresolved', note }  - no live data source yet; always renders 0 and gets flagged
function flatSite(slug) {
  return {
    elec: { kind: 'flat_site', slug, part: 'elec' },
    water: { kind: 'flat_site', slug, part: 'water' },
    sewer: { kind: 'flat_site', slug, part: 'sewer' },
  };
}
function tenantRow(slug, names, utilityCode) { return { kind: 'tenant', slug, names, utilityCode }; }

const ROWS = [
  // ---- CSV BEV: AutoZone (79) + Wingfield (38) ----
  { file: 'BEV', building: 79, tenantCode: 189, tenantCode2: 189, utility: 'EL00', src: flatSite('autozone').elec },
  { file: 'BEV', building: 79, tenantCode: 189, tenantCode2: 189, utility: 'WT00', src: flatSite('autozone').water },
  { file: 'BEV', building: 79, tenantCode: 189, tenantCode2: 189, utility: 'SE00', src: flatSite('autozone').sewer },

  { file: 'BEV', building: 38, tenantCode: 155, tenantCode2: 155, utility: 'EL00', src: tenantRow('wingfield', ['342 Logistics'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 155, tenantCode2: 155, utility: 'WT00', src: tenantRow('wingfield', ['342 Logistics'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 155, tenantCode2: 155, utility: 'SE00', src: tenantRow('wingfield', ['342 Logistics'], 'SE00') },

  // NOTE: TenantCode2 (D=193) doesn't match TenantCode (C=269) in the client's own original file -
  // see file header note. Reproduced literally; identity used for the amount is Arch International
  // Logistics (269), not Cards Plus (193).
  { file: 'BEV', building: 38, tenantCode: 269, tenantCode2: 193, utility: 'EL00', src: tenantRow('wingfield', ['Arch International Logistics'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 269, tenantCode2: 193, utility: 'WT00', src: tenantRow('wingfield', ['Arch International Logistics'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 269, tenantCode2: 193, utility: 'SE00', src: tenantRow('wingfield', ['Arch International Logistics'], 'SE00') },

  { file: 'BEV', building: 38, tenantCode: 193, tenantCode2: 193, utility: 'EL00', src: tenantRow('wingfield', ['Cards Plus'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 193, tenantCode2: 193, utility: 'WT00', src: tenantRow('wingfield', ['Cards Plus'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 193, tenantCode2: 193, utility: 'SE00', src: tenantRow('wingfield', ['Cards Plus'], 'SE00') },

  // 158 = "IHS Towers" in the client's code list - client confirmed 2026-09-21 this is actually MTN.
  { file: 'BEV', building: 38, tenantCode: 158, tenantCode2: 158, utility: 'EL00', src: tenantRow('wingfield', ['MTN'], 'EL00') },

  { file: 'BEV', building: 38, tenantCode: 309, tenantCode2: 309, utility: 'EL00', src: tenantRow('wingfield', ['Overnight Logistics'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 309, tenantCode2: 309, utility: 'WT00', src: tenantRow('wingfield', ['Overnight Logistics'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 309, tenantCode2: 309, utility: 'SE00', src: tenantRow('wingfield', ['Overnight Logistics'], 'SE00') },

  { file: 'BEV', building: 38, tenantCode: 159, tenantCode2: 159, utility: 'EL00', src: tenantRow('wingfield', ['Overseas Development'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 159, tenantCode2: 159, utility: 'WT00', src: tenantRow('wingfield', ['Overseas Development'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 159, tenantCode2: 159, utility: 'SE00', src: tenantRow('wingfield', ['Overseas Development'], 'SE00') },

  { file: 'BEV', building: 38, tenantCode: 256, tenantCode2: 256, utility: 'EL00', src: tenantRow('wingfield', ['Ptyprops 348 (Pty) Ltd'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 256, tenantCode2: 256, utility: 'WT00', src: tenantRow('wingfield', ['Ptyprops 348 (Pty) Ltd'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 256, tenantCode2: 256, utility: 'SE00', src: tenantRow('wingfield', ['Ptyprops 348 (Pty) Ltd'], 'SE00') },

  { file: 'BEV', building: 38, tenantCode: 226, tenantCode2: 226, utility: 'EL00', src: tenantRow('wingfield', ['Safe Quip'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 226, tenantCode2: 226, utility: 'WT00', src: tenantRow('wingfield', ['Safe Quip'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 226, tenantCode2: 226, utility: 'SE00', src: tenantRow('wingfield', ['Safe Quip'], 'SE00') },

  { file: 'BEV', building: 38, tenantCode: 306, tenantCode2: 306, utility: 'EL00', src: tenantRow('wingfield', ['Sange SA'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 306, tenantCode2: 306, utility: 'WT00', src: tenantRow('wingfield', ['Sange SA'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 306, tenantCode2: 306, utility: 'SE00', src: tenantRow('wingfield', ['Sange SA'], 'SE00') },

  // The Core Computer Business (151) - 5 per-meter EL00 rows (client's 2026-09-21 choice, expanded
  // from the original template's 3), then a normal combined WT00/SE00 row.
  ...CORE_COMPUTER_BUSINESS_METERS.map((serial) => ({
    file: 'BEV', building: 38, tenantCode: 151, tenantCode2: 151, utility: 'EL00', src: { kind: 'core_meter', serial },
  })),
  { file: 'BEV', building: 38, tenantCode: 151, tenantCode2: 151, utility: 'WT00', src: tenantRow('wingfield', ['The Core Computer Business'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 151, tenantCode2: 151, utility: 'SE00', src: tenantRow('wingfield', ['The Core Computer Business'], 'SE00') },

  { file: 'BEV', building: 38, tenantCode: 186, tenantCode2: 186, utility: 'EL00', src: tenantRow('wingfield', ['TRVSA'], 'EL00') },
  { file: 'BEV', building: 38, tenantCode: 186, tenantCode2: 186, utility: 'WT00', src: tenantRow('wingfield', ['TRVSA'], 'WT00') },
  { file: 'BEV', building: 38, tenantCode: 186, tenantCode2: 186, utility: 'SE00', src: tenantRow('wingfield', ['TRVSA'], 'SE00') },

  // ---- CSV Lisa: everything else ----
  { file: 'LISA', building: 2, tenantCode: 223363, tenantCode2: 223363, utility: 'EL00', src: tenantRow('city-deep', ['Kimmo (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 2, tenantCode: 223363, tenantCode2: 223363, utility: 'WT00', src: tenantRow('city-deep', ['Kimmo (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 2, tenantCode: 223366, tenantCode2: 223366, utility: 'EL00', src: tenantRow('city-deep', ['Agrana Fruit South Africa (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 2, tenantCode: 223366, tenantCode2: 223366, utility: 'WT00', src: tenantRow('city-deep', ['Agrana Fruit South Africa (Pty) Ltd'], 'WT00') },
  { file: 'LISA', building: 2, tenantCode: 223366, tenantCode2: 223366, utility: 'EL01', src: { kind: 'solar_credit', solarKey: 'agrana' } },

  { file: 'LISA', building: 2, tenantCode: 223347, tenantCode2: 223347, utility: 'EL00', src: tenantRow('city-deep', ['Lesco Manufacturing (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 2, tenantCode: 223347, tenantCode2: 223347, utility: 'WT00', src: tenantRow('city-deep', ['Lesco Manufacturing (Pty) Ltd'], 'WT00') },
  { file: 'LISA', building: 2, tenantCode: 223347, tenantCode2: 223347, utility: 'EL01', src: { kind: 'solar_credit', solarKey: 'lesco' } },

  { file: 'LISA', building: 2, tenantCode: 223352, tenantCode2: 223352, utility: 'EL00', src: tenantRow('city-deep', ['Skillcraft Agencies (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 2, tenantCode: 223352, tenantCode2: 223352, utility: 'WT00', src: tenantRow('city-deep', ['Skillcraft Agencies (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 2, tenantCode: 223362, tenantCode2: 223362, utility: 'EL00', src: tenantRow('city-deep', ['Hudaco Trading (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 2, tenantCode: 223362, tenantCode2: 223362, utility: 'WT00', src: tenantRow('city-deep', ['Hudaco Trading (Pty) Ltd'], 'WT00') },
  { file: 'LISA', building: 2, tenantCode: 223362, tenantCode2: 223362, utility: 'EL01', src: { kind: 'solar_credit', solarKey: 'hudaco' } },

  // JC Bakeries (223361) - client's own template lists this code TWICE, as two full EL00+WT00
  // blocks rather than one combined row (unlike every other multi-unit tenant above/below, which get
  // ONE summed row). Reproduced literally as 2 separate unit-level rows (Unit 4A, Unit 4B) rather
  // than guessed as a copy/paste duplicate - flagged in the README/final report for the client to
  // confirm this is what they actually want.
  { file: 'LISA', building: 2, tenantCode: 223361, tenantCode2: 223361, utility: 'EL00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'JC Bakeries (Pty) Ltd', unit: 'Unit 4A', utilityCode: 'EL00' } },
  { file: 'LISA', building: 2, tenantCode: 223361, tenantCode2: 223361, utility: 'WT00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'JC Bakeries (Pty) Ltd', unit: 'Unit 4A', utilityCode: 'WT00' } },
  { file: 'LISA', building: 2, tenantCode: 223361, tenantCode2: 223361, utility: 'EL00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'JC Bakeries (Pty) Ltd', unit: 'Unit 4B', utilityCode: 'EL00' } },
  { file: 'LISA', building: 2, tenantCode: 223361, tenantCode2: 223361, utility: 'WT00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'JC Bakeries (Pty) Ltd', unit: 'Unit 4B', utilityCode: 'WT00' } },

  { file: 'LISA', building: 2, tenantCode: 223364, tenantCode2: 223364, utility: 'EL00', src: tenantRow('city-deep', ['Teraoka Sa (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 2, tenantCode: 223364, tenantCode2: 223364, utility: 'WT00', src: tenantRow('city-deep', ['Teraoka Sa (Pty) Ltd'], 'WT00') },
  { file: 'LISA', building: 2, tenantCode: 223364, tenantCode2: 223364, utility: 'EL01', src: { kind: 'solar_credit', solarKey: 'teraoka' } },

  { file: 'LISA', building: 2, tenantCode: 223367, tenantCode2: 223367, utility: 'EL00', src: tenantRow('city-deep', ['ATC SA Wireless Infrastructure (Pty) Ltd'], 'EL00') },

  { file: 'LISA', building: 1, tenantCode: 223330, tenantCode2: 223330, utility: 'EL00', src: tenantRow('city-deep', ['Growers Connect (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 1, tenantCode: 223330, tenantCode2: 223330, utility: 'WT00', src: tenantRow('city-deep', ['Growers Connect (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223336, tenantCode2: 223336, utility: 'EL00', src: tenantRow('city-deep', ['Network Dynamics (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223336, tenantCode2: 223336, utility: 'WT00', src: tenantRow('city-deep', ['Network Dynamics (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223342, tenantCode2: 223342, utility: 'EL00', src: tenantRow('city-deep', ['Express Chef Sauces (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223342, tenantCode2: 223342, utility: 'WT00', src: tenantRow('city-deep', ['Express Chef Sauces (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223339, tenantCode2: 223339, utility: 'EL00', src: tenantRow('city-deep', ['Uber Nutrition (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223339, tenantCode2: 223339, utility: 'WT00', src: tenantRow('city-deep', ['Uber Nutrition (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223338, tenantCode2: 223338, utility: 'EL00', src: tenantRow('city-deep', ['Americandy Manufacturers (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223338, tenantCode2: 223338, utility: 'WT00', src: tenantRow('city-deep', ['Americandy Manufacturers (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223891, tenantCode2: 223891, utility: 'EL00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'Sanskar Trading CC', unit: 'Unit 3', utilityCode: 'EL00' } },
  { file: 'LISA', building: 3, tenantCode: 223891, tenantCode2: 223891, utility: 'WT00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'Sanskar Trading CC', unit: 'Unit 3', utilityCode: 'WT00' } },

  { file: 'LISA', building: 3, tenantCode: 223341, tenantCode2: 223341, utility: 'EL00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'Sanskar Trading CC', unit: 'Unit 9', utilityCode: 'EL00' } },
  { file: 'LISA', building: 3, tenantCode: 223341, tenantCode2: 223341, utility: 'WT00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'Sanskar Trading CC', unit: 'Unit 9', utilityCode: 'WT00' } },

  { file: 'LISA', building: 3, tenantCode: 223334, tenantCode2: 223334, utility: 'EL00', src: tenantRow('city-deep', ['Berzack Brothers (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223334, tenantCode2: 223334, utility: 'WT00', src: tenantRow('city-deep', ['Berzack Brothers (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223458, tenantCode2: 223458, utility: 'EL00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'Agrana Fruit South Africa (Pty) Ltd', unit: 'Unit 5', utilityCode: 'EL00' } },
  { file: 'LISA', building: 3, tenantCode: 223458, tenantCode2: 223458, utility: 'WT00', src: { kind: 'tenant_by_id_name', slug: 'city-deep', name: 'Agrana Fruit South Africa (Pty) Ltd', unit: 'Unit 5', utilityCode: 'WT00' } },

  { file: 'LISA', building: 3, tenantCode: 223376, tenantCode2: 223376, utility: 'EL00', src: tenantRow('city-deep', ['Surplus Grain Traders CC'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223376, tenantCode2: 223376, utility: 'WT00', src: tenantRow('city-deep', ['Surplus Grain Traders CC'], 'WT00') },

  { file: 'LISA', building: 3, tenantCode: 223340, tenantCode2: 223340, utility: 'EL00', src: tenantRow('city-deep', ['Citrashine (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223340, tenantCode2: 223340, utility: 'WT00', src: tenantRow('city-deep', ['Citrashine (Pty) Ltd'], 'WT00') },

  // 223350 "Uber Nutrition - Unit 9" per the client's xlsx - no live tenant exists yet (see file
  // header note). Always resolves to 0 and gets flagged in the export result until city-deep/seed.js
  // implements the documented Sanskar -> Uber Nutrition handover and a 2026-09+ period is seeded.
  { file: 'LISA', building: 3, tenantCode: 223350, tenantCode2: 223350, utility: 'EL00', src: { kind: 'unresolved', note: 'Uber Nutrition "Unit 9" has no live tenant yet in city-deep.db - the Sanskar Trading CC handover for this unit is confirmed but not yet implemented (see city-deep/seed.js). Resolves to 0 until then.' } },
  { file: 'LISA', building: 3, tenantCode: 223350, tenantCode2: 223350, utility: 'WT00', src: { kind: 'unresolved', note: 'Uber Nutrition "Unit 9" has no live tenant yet in city-deep.db - see the EL00 row above for the same note.' } },

  { file: 'LISA', building: 3, tenantCode: 223343, tenantCode2: 223343, utility: 'EL00', src: tenantRow('city-deep', ['Twinpouch (Pty) Ltd'], 'EL00') },
  { file: 'LISA', building: 3, tenantCode: 223343, tenantCode2: 223343, utility: 'WT00', src: tenantRow('city-deep', ['Twinpouch (Pty) Ltd'], 'WT00') },

  { file: 'LISA', building: 4, tenantCode: 1000, tenantCode2: 1000, utility: 'EL00', src: flatSite('loper-road').elec },
  { file: 'LISA', building: 4, tenantCode: 1000, tenantCode2: 1000, utility: 'WT00', src: flatSite('loper-road').water },
  { file: 'LISA', building: 4, tenantCode: 1000, tenantCode2: 1000, utility: 'SE00', src: flatSite('loper-road').sewer },

  { file: 'LISA', building: 5, tenantCode: 1001, tenantCode2: 1001, utility: 'EL00', src: flatSite('field-street').elec },
  { file: 'LISA', building: 5, tenantCode: 1001, tenantCode2: 1001, utility: 'WT00', src: flatSite('field-street').water },
  { file: 'LISA', building: 5, tenantCode: 1001, tenantCode2: 1001, utility: 'SE00', src: flatSite('field-street').sewer },

  { file: 'LISA', building: 6, tenantCode: 3004, tenantCode2: 3004, utility: 'EL00', src: flatSite('rcl-group').elec },
  { file: 'LISA', building: 6, tenantCode: 3004, tenantCode2: 3004, utility: 'WT00', src: flatSite('rcl-group').water },
  { file: 'LISA', building: 6, tenantCode: 3004, tenantCode2: 3004, utility: 'SE00', src: flatSite('rcl-group').sewer },

  { file: 'LISA', building: '6.1', tenantCode: 1004, tenantCode2: 1004, utility: 'EL00', src: flatSite('bob-martin').elec },
  { file: 'LISA', building: '6.1', tenantCode: 1004, tenantCode2: 1004, utility: 'WT00', src: flatSite('bob-martin').water },
  { file: 'LISA', building: '6.1', tenantCode: 1004, tenantCode2: 1004, utility: 'SE00', src: flatSite('bob-martin').sewer },

  { file: 'LISA', building: '6.2', tenantCode: 1005, tenantCode2: 1005, utility: 'EL00', src: flatSite('cranbrook-flavours').elec },
  { file: 'LISA', building: '6.2', tenantCode: 1005, tenantCode2: 1005, utility: 'WT00', src: flatSite('cranbrook-flavours').water },
  { file: 'LISA', building: '6.2', tenantCode: 1005, tenantCode2: 1005, utility: 'SE00', src: flatSite('cranbrook-flavours').sewer },

  { file: 'LISA', building: '6.3', tenantCode: 3000, tenantCode2: 3000, utility: 'EL00', src: flatSite('zelvio-global').elec },
  { file: 'LISA', building: '6.3', tenantCode: 3000, tenantCode2: 3000, utility: 'WT00', src: flatSite('zelvio-global').water },
  { file: 'LISA', building: '6.3', tenantCode: 3000, tenantCode2: 3000, utility: 'SE00', src: flatSite('zelvio-global').sewer },

  { file: 'LISA', building: '6.3', tenantCode: 3001, tenantCode2: 3001, utility: 'EL00', src: flatSite('adh-machine-tool').elec },
  { file: 'LISA', building: '6.3', tenantCode: 3001, tenantCode2: 3001, utility: 'WT00', src: flatSite('adh-machine-tool').water },
  { file: 'LISA', building: '6.3', tenantCode: 3001, tenantCode2: 3001, utility: 'SE00', src: flatSite('adh-machine-tool').sewer },

  { file: 'LISA', building: '6.4', tenantCode: 3002, tenantCode2: 3002, utility: 'EL00', src: flatSite('colorobbia').elec },
  { file: 'LISA', building: '6.4', tenantCode: 3002, tenantCode2: 3002, utility: 'WT00', src: flatSite('colorobbia').water },
  { file: 'LISA', building: '6.4', tenantCode: 3002, tenantCode2: 3002, utility: 'SE00', src: flatSite('colorobbia').sewer },

  { file: 'LISA', building: '6.5', tenantCode: 3003, tenantCode2: 3003, utility: 'EL00', src: flatSite('interoll').elec },
  { file: 'LISA', building: '6.5', tenantCode: 3003, tenantCode2: 3003, utility: 'WT00', src: flatSite('interoll').water },
  { file: 'LISA', building: '6.5', tenantCode: 3003, tenantCode2: 3003, utility: 'SE00', src: flatSite('interoll').sewer },
];

// tenant_by_id_name: like tenantRow, but pins to exactly one tenant row by (name, unit) instead of
// summing every tenant row sharing that name - used wherever the client's own template keeps
// multiple physical units under the SAME external tenant code as SEPARATE rows (JC Bakeries) or
// where two different external codes both draw from the SAME name but different units (Sanskar
// Trading CC Unit 3 vs Unit 9, Agrana's Mini Park Unit 5 vs its Industrial Park units).
function tenantByIdNameAmount(db, name, unit, periodId, propSlug, utilityCode) {
  const bucket = CATEGORY_BUCKETS[propSlug][utilityCode];
  const tenant = get(db, 'SELECT id FROM tenants WHERE name=? AND unit=?', [name, unit]);
  if (!tenant) return 0;
  return billLineItemsTotal(db, tenant.id, periodId, bucket);
}

// A bill's own override_start_date/override_end_date (db.js's migrate() comment; set for City
// Deep's Aug 2026 Americandy/Twinpouch handover by city-deep/seed.js) lets ONE tenant's ONE bill
// show a different F/G date range in this CSV than the rest of the property for that month, same as
// it already does on that tenant's own billing-slip PDF (server.js's /pdf/:billId route) - the two
// documents should read as a matched pair. Only applied when the row is backed by exactly one tenant
// row (a summed multi-unit code - e.g. Agrana's 2 Industrial Park units - has no single unambiguous
// override to apply); falls back to the shared billing_periods dates otherwise, same as always.
function tenantDatesForRow(db, tenantIds, period) {
  if (tenantIds.length === 1) {
    const bill = get(db, 'SELECT override_start_date, override_end_date FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenantIds[0], period.id]);
    if (bill && (bill.override_start_date || bill.override_end_date)) {
      return { startDate: bill.override_start_date || period.start_date, endDate: bill.override_end_date || period.end_date };
    }
  }
  return { startDate: period.start_date, endDate: period.end_date };
}

// Resolves one row's amount + period start/end for a given label. `propertyDbs` is a Map of
// slug -> DatabaseSync (every property's own db, regardless of which one is "active" in the current
// session - this export spans every property at once). Returns { amount, startDate, endDate, flag }
// - `flag` is a short string set only when the row couldn't be fully resolved (unresolved rows,
// missing slip/bill for this period), so the caller can surface it rather than silently show 0.
function resolveRow(propertyDbs, label, row) {
  const src = row.src;
  if (src.kind === 'flat_site') {
    const db = propertyDbs.get(src.slug);
    const figures = db && flatSiteFigures(db, label);
    if (!figures) return { amount: 0, startDate: null, endDate: null, flag: `No site billing slip for "${label}" yet on ${src.slug}.` };
    const amount = src.part === 'elec' ? figures.elecTotal : src.part === 'water' ? figures.waterTotal : figures.sewerTotal;
    return { amount, startDate: figures.startDate, endDate: figures.endDate, flag: null };
  }
  if (src.kind === 'tenant') {
    const db = propertyDbs.get(src.slug);
    const period = db && billingPeriod(db, label);
    if (!period) return { amount: 0, startDate: null, endDate: null, flag: `No billing period "${label}" yet on ${src.slug}.` };
    const amount = tenantModelAmount(db, src.slug, src.names, period.id, src.utilityCode);
    const tenants = all(db, `SELECT id FROM tenants WHERE name IN (${src.names.map(() => '?').join(',')})`, src.names);
    const dates = tenantDatesForRow(db, tenants.map((t) => t.id), period);
    return { amount, startDate: dates.startDate, endDate: dates.endDate, flag: null };
  }
  if (src.kind === 'tenant_by_id_name') {
    const db = propertyDbs.get(src.slug);
    const period = db && billingPeriod(db, label);
    if (!period) return { amount: 0, startDate: null, endDate: null, flag: `No billing period "${label}" yet on ${src.slug}.` };
    const amount = tenantByIdNameAmount(db, src.name, src.unit, period.id, src.slug, src.utilityCode);
    const tenant = get(db, 'SELECT id FROM tenants WHERE name=? AND unit=?', [src.name, src.unit]);
    const dates = tenantDatesForRow(db, tenant ? [tenant.id] : [], period);
    return { amount, startDate: dates.startDate, endDate: dates.endDate, flag: null };
  }
  if (src.kind === 'core_meter') {
    const db = propertyDbs.get('wingfield');
    const period = db && billingPeriod(db, label);
    if (!period) return { amount: 0, startDate: null, endDate: null, flag: 'No Wingfield billing period yet.' };
    const amount = coreComputerBusinessMeterAmount(db, period.id, src.serial);
    return { amount, startDate: period.start_date, endDate: period.end_date, flag: null };
  }
  if (src.kind === 'solar_credit') {
    const db = propertyDbs.get('city-deep');
    const period = db && billingPeriod(db, label);
    if (!period) return { amount: 0, startDate: null, endDate: null, flag: 'No City Deep billing period yet.' };
    const amount = solarCreditAmount(db, period.id, src.solarKey);
    return { amount, startDate: period.start_date, endDate: period.end_date, flag: null };
  }
  // unresolved
  return { amount: 0, startDate: null, endDate: null, flag: src.note };
}

// Builds every row for one file ('BEV'|'LISA') for the given period label, in template order.
function buildRows(propertyDbs, label, file) {
  return ROWS.filter((r) => r.file === file).map((row) => {
    const resolved = resolveRow(propertyDbs, label, row);
    return { ...row, ...resolved };
  });
}

// Renders one file's rows as CSV text, matching the client's own template exactly: no header row,
// column order Building/flag/TenantCode/TenantCode2/Utility/F(end date)/G(start date)/1/Amount/
// (4 blank columns)/"Elec period", CRLF line endings (Windows/Excel-friendly, matching the client's
// own uploaded files).
function toCsv(rows) {
  const lines = rows.map((r) => [
    r.building, 'N', r.tenantCode, r.tenantCode2, r.utility,
    fmtDate(r.endDate), fmtDate(r.startDate), 1, fmtAmount(r.amount),
    '', '', '', '', 'Elec period',
  ].join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { ROWS, buildRows, toCsv, resolveRow };
