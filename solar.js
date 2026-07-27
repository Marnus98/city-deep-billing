// solar.js - "Solar Billing Slips" report: for each of the 6 tenant groups that have a
// dedicated PV/solar installation feeding their supply (Kimo, Lesco, Agrana, Hudaco, Teraoka SA,
// SkillCraft, JC Bakery - Lesco and Agrana are billed as separate tenants so 7 slips total), shows
// a breakdown of how much of that tenant's already-billed electricity energy charge came from the
// municipal grid vs. from the on-site solar installation.
//
// This is a REPORTING layer only - it does not change any billed amount. Every "Total Due" figure
// computed here is reconstructed from the exact same bill_line_items rows the main billing engine
// (calc.js/seed.js/billing.js) already produced, so it reconciles by construction. The formula
// trees below were transcribed cell-by-cell from the tenant's own example workbook ("City Deep June
// 2026 with solar Recon - W_Solar slips.xlsx", one worksheet per tenant group) and verified against
// that workbook's own totals (see README "Solar Billing Slips").
//
// Meter serials are stable across all 13 imported months (July 2025 - July 2026), confirmed by
// checking every month's 'Elect Readings' sheet, so a single hardcoded topology below (keyed by
// serial number, not sheet row) works for every period without per-month adjustment.
const { activeTariffParams } = require('./billing');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }

// The 4 "bulk meter export" submeters (one per mini-sub: B, D, E, F) measure how much a whole
// mini-substation exported back to the grid. They aren't billed to any single tenant (so they never
// go through calc.js / never get a bill_line_items row) - they're imported directly into
// meters/meter_readings by seed.js's seedSolarBulkMeters() purely so this report can read them.
const BULK_EXPORT_SERIALS = new Set(['35726713E', '35775954E', '35776118E', '36533986E']);

// ---- value helpers: every value flowing through this module is a signed {kwh, rand} pair,
// matching the sign convention already baked into the source workbook's own 'D' column (a
// municipal/import meter is positive, an export/credit meter is negative). ----
function add(...vals) { return vals.reduce((s, v) => ({ kwh: s.kwh + v.kwh, rand: s.rand + v.rand }), { kwh: 0, rand: 0 }); }
function scale(v, f) { return { kwh: v.kwh * f, rand: v.rand * f }; }
function neg(v) { return { kwh: -v.kwh, rand: -v.rand }; }
function line(label, serial, value, bold) { return { label, serial: serial || null, kwh: value.kwh, rand: value.rand, bold: !!bold, missing: !!value.missing }; }

// Pulls the already-computed energy-charge line item for one meter in one period straight off the
// tenant's real bill (bill_line_items.category = 'energy_charge', written by calc.js). quantity is
// stored unsigned there; sign comes from that meter's assignment (open as of the period start).
function billedEnergy(db, serial, periodId, periodStartDate) {
  const row = get(db, `
    SELECT bli.quantity AS qty, bli.amount AS rand, ma.sign AS sign
    FROM meters m
    JOIN bill_line_items bli ON bli.meter_id = m.id AND bli.category = 'energy_charge'
    JOIN bills b ON b.id = bli.bill_id AND b.billing_period_id = ?
    LEFT JOIN meter_assignments ma ON ma.meter_id = m.id
      AND ma.effective_from <= ? AND (ma.effective_to IS NULL OR ma.effective_to > ?)
    WHERE m.serial = ?
    ORDER BY ma.id DESC
    LIMIT 1
  `, [periodId, periodStartDate, periodStartDate, serial]);
  if (!row) return { kwh: 0, rand: 0, missing: true };
  const sign = row.sign == null ? (row.rand < 0 ? -1 : 1) : row.sign;
  return { kwh: (row.qty || 0) * sign, rand: row.rand || 0 };
}

// The 4 unbilled bulk-export meters: read the raw reading delta directly and value it at the flat
// (tariff-1) energy rate - confirmed against the source workbook, every "Bulk Meter Export" row
// uses tariff 1 and is always subtracted (it represents kWh the mini-sub exported, i.e. available
// to be "used" by tenants downstream).
function bulkExportEnergy(db, serial, periodId, tariff1) {
  const row = get(db, `
    SELECT mr.start_reading, mr.end_reading, m.unit_scale
    FROM meter_readings mr JOIN meters m ON m.id = mr.meter_id
    WHERE m.serial = ? AND mr.billing_period_id = ?
  `, [serial, periodId]);
  if (!row) return { kwh: 0, rand: 0, missing: true };
  const usage = (row.end_reading - row.start_reading) * (row.unit_scale || 1);
  const kwh = -usage;
  const rand = tariff1 ? kwh * tariff1.energyRate : 0;
  return { kwh, rand };
}

// ---------- 1. Kimo ----------
function computeKimo(db, periodId, periodStart) {
  const muniAA = billedEnergy(db, '33883387', periodId, periodStart);
  const solarProdAA = billedEnergy(db, '35775711', periodId, periodStart);
  const exportAA = billedEnergy(db, '33883387E', periodId, periodStart);
  const solarUsedAA = add(solarProdAA, exportAA);
  const totalDueAA = add(muniAA, solarUsedAA);

  const dbAA = billedEnergy(db, '33883386', periodId, periodStart);
  const dbAC = billedEnergy(db, '33883385', periodId, periodStart);
  const totalDueA = add(dbAA, dbAC);
  const muniMixed = scale(totalDueA, 0.3);
  const solarMixed = scale(totalDueA, 0.7);

  const totalMuni = add(muniAA, dbAA, dbAC);
  const totalSolar = solarUsedAA;
  const totalDue = add(totalMuni, totalSolar);

  return {
    key: 'kimo', title: 'Unit 1 Kimo',
    sections: [
      { heading: 'Sub A – Unit 1 AA (Kimo)', rows: [
        line('Tenant Munic Usage', '33883387', muniAA),
        line('Solar Used', null, solarUsedAA),
        line('Total Due', null, totalDueAA, true),
        line('  Solar Production', '35775711', solarProdAA),
        line('  Tenant Export', '33883387E', exportAA),
      ] },
      { heading: 'Sub A – Unit 1 A (Kimo) – estimated 30/70 municipal/solar split', rows: [
        line('DB AA', '33883386', dbAA),
        line('DB A/C', '33883385', dbAC),
        line('Total Due', null, totalDueA, true),
        line('Munisipal Usage (30%)', null, muniMixed),
        line('Solar Used (70%)', null, solarMixed),
      ] },
    ],
    total: { muniUsage: totalMuni, solarUsed: totalSolar, due: totalDue },
  };
}

// ---------- 2. Lesco ----------
function computeLesco(db, periodId, periodStart) {
  const muni = billedEnergy(db, '35775956', periodId, periodStart);
  const solarProd = billedEnergy(db, '35778872', periodId, periodStart);
  const exp = billedEnergy(db, '35775956E', periodId, periodStart);
  const solarUsed = add(solarProd, exp);
  const totalDue = add(muni, solarUsed);
  return {
    key: 'lesco', title: 'Unit 2A Lesco',
    sections: [
      { heading: 'Sub B – Unit 2A (Lesco)', rows: [
        line('Tenant Munic Usage', '35775956', muni),
        line('Solar Used', null, solarUsed),
        line('Total Due', null, totalDue, true),
        line('  Solar Production', '35778872', solarProd),
        line('  Tenant Export', '35775956E', exp),
      ] },
    ],
    total: { muniUsage: muni, solarUsed, due: totalDue },
    _exportForAgrana: exp,
  };
}

// ---------- 3. Agrana (needs Lesco's own export value, computed above) ----------
function computeAgrana(db, periodId, periodStart, tariff1, lescoExport) {
  const muniC = billedEnergy(db, '35775957', periodId, periodStart);
  const solarProdC = billedEnergy(db, '35778873', periodId, periodStart);
  const exportC = billedEnergy(db, '35775957E', periodId, periodStart);
  const solarUsedC = add(solarProdC, exportC);
  const totalDueC = add(muniC, solarUsedC);

  const mixedB = billedEnergy(db, '35775955', periodId, periodStart);
  const bulkExportB = bulkExportEnergy(db, '35775954E', periodId, tariff1);
  const tenantExportLesco = neg(lescoExport);
  const tenantExportAgrana = neg(exportC);
  const solarUsedB = add(bulkExportB, tenantExportLesco, tenantExportAgrana);
  const muniUsedB = { kwh: mixedB.kwh - solarUsedB.kwh, rand: mixedB.rand - solarUsedB.rand };

  const totalMuni = add(muniC, mixedB);
  const totalSolar = solarUsedC; // netted (production minus tenant export) - the source workbook's
  // "Total" row shows raw production kWh here but a netted Rand figure (an internal inconsistency
  // in that one cell, confirmed by cross-checking against the tenant's actual billed total), so this
  // uses the netted figure consistently for both so the Rand total reconciles.
  const totalDue = add(totalMuni, totalSolar);

  return {
    key: 'agrana', title: 'Unit 2C/2B Agrana',
    sections: [
      { heading: 'Sub B – Unit 2C (Agrana)', rows: [
        line('Tenant Munic Usage', '35775957', muniC),
        line('Solar Used', null, solarUsedC),
        line('Total Due', null, totalDueC, true),
        line('  Solar Production', '35778873', solarProdC),
        line('  Tenant Export', '35775957E', exportC),
      ] },
      { heading: 'Sub B – Unit 2B (Agrana, shared)', rows: [
        line('Tenant Mixed Usage', '35775955', mixedB),
        line('Total Due', null, mixedB, true),
        line('  Bulk Meter Export', '35775954E', bulkExportB),
        line('  Tenant Export from Unit 2A (Lesco)', null, tenantExportLesco),
        line('  Tenant Export from Unit 2C (Agrana)', null, tenantExportAgrana),
        line('Munisipal Usage', null, muniUsedB),
        line('Solar Used', null, solarUsedB),
      ] },
    ],
    total: { muniUsage: totalMuni, solarUsed: totalSolar, due: totalDue },
  };
}

// ---------- 4. Hudaco ----------
function computeHudaco(db, periodId, periodStart) {
  const cb1 = billedEnergy(db, '35776117', periodId, periodStart);
  const cb2 = billedEnergy(db, '35776114', periodId, periodStart);
  const cl = billedEnergy(db, '35775649', periodId, periodStart);
  const cx = billedEnergy(db, '36533987', periodId, periodStart);
  const totalMuniRaw = add(cb1, cb2, cl, cx);
  const solarProd = billedEnergy(db, '35775710', periodId, periodStart);
  const exp = billedEnergy(db, '35776127E', periodId, periodStart);
  const solarUsed = add(solarProd, exp);
  const totalDue = add(totalMuniRaw, solarUsed);
  return {
    key: 'hudaco', title: 'Unit 3 Hudaco',
    sections: [
      { heading: 'Sub C – Unit 3 (Hudaco Trading)', rows: [
        line('DB-CB', '35776117', cb1),
        line('DB-CB', '35776114', cb2),
        line('DB-CL', '35775649', cl),
        line('DB-CX', '36533987', cx),
        line('Solar Used', null, solarUsed),
        line('Total Due', null, totalDue, true),
        line('  Solar Production', '35775710', solarProd),
        line('  Tenant Export', '35776127E', exp),
      ] },
    ],
    total: { muniUsage: totalMuniRaw, solarUsed, due: totalDue },
  };
}

// ---------- 5. Teraoka SA ----------
function computeTeraoka(db, periodId, periodStart, tariff1) {
  const muniAB = billedEnergy(db, '36533988', periodId, periodStart);
  const solarProdAB = billedEnergy(db, '36339313', periodId, periodStart);
  const exportAB = billedEnergy(db, '36533988E', periodId, periodStart);
  const solarUsedAB = add(solarProdAB, exportAB);
  const totalDueAB = add(muniAB, solarUsedAB);

  const mixedC = billedEnergy(db, '36533989', periodId, periodStart);
  // SA Wireless Infrastructure shares this physical meter with Teraoka's Unit 6C; their portion is
  // credited back here (negative) and billed separately on their own tenant bill - same underlying
  // bill_line_items row (serial 11100461380R, sign -1) the main billing engine already produces.
  const saWireless = billedEnergy(db, '11100461380R', periodId, periodStart);
  const totalDueC = add(mixedC, saWireless);

  const bulkExportF = bulkExportEnergy(db, '36533986E', periodId, tariff1);
  const tenantExportAB = neg(exportAB);
  const solarUsedC = add(bulkExportF, tenantExportAB);
  const muniUsedC = { kwh: mixedC.kwh - solarUsedC.kwh, rand: mixedC.rand - solarUsedC.rand };

  const totalMuni = add(muniAB, mixedC);
  const totalSolar = add(solarUsedAB, saWireless);
  const totalDue = add(totalMuni, totalSolar);

  return {
    key: 'teraoka', title: 'Unit 6 Teraoka SA',
    sections: [
      { heading: 'Sub F – Unit 6A & B (Teraoka SA)', rows: [
        line('Tenant Munic Usage', '36533988', muniAB),
        line('Solar Used', null, solarUsedAB),
        line('Total Due', null, totalDueAB, true),
        line('  Solar Production', '36339313', solarProdAB),
        line('  Tenant Export', '36533988E', exportAB),
      ] },
      { heading: 'Sub F – Unit 6C (Teraoka SA, shared with SA Wireless)', rows: [
        line('Tenant Mixed Usage', '36533989', mixedC),
        line('SA Wireless (credited to their own bill)', '11100461380R', saWireless),
        line('Total Due', null, totalDueC, true),
        line('  Bulk Meter Export', '36533986E', bulkExportF),
        line('  Tenant Export from Unit 6A & B', null, tenantExportAB),
        line('Munisipal Usage', null, muniUsedC),
        line('Solar Used', null, solarUsedC),
      ] },
    ],
    total: { muniUsage: totalMuni, solarUsed: totalSolar, due: totalDue },
  };
}

// ---------- 6. SkillCraft ----------
function computeSkillCraft(db, periodId, periodStart, tariff1) {
  const muniA = billedEnergy(db, '35776120', periodId, periodStart);
  const solarProdA = billedEnergy(db, '35775887', periodId, periodStart);
  const exportA = billedEnergy(db, '35776120E', periodId, periodStart);
  const solarUsedA = add(solarProdA, exportA);
  const totalDueA = add(muniA, solarUsedA);

  const muniBEast = billedEnergy(db, '35775648', periodId, periodStart);
  const solarProdBEast = billedEnergy(db, '35775886', periodId, periodStart);
  const exportBEast = billedEnergy(db, '35775648E', periodId, periodStart);
  const solarUsedBEast = add(solarProdBEast, exportBEast);
  const totalDueBEast = add(muniBEast, solarUsedBEast);

  const mixedB = billedEnergy(db, '35776119', periodId, periodStart);
  const bulkExportE = bulkExportEnergy(db, '35776118E', periodId, tariff1);
  const tenantExportA = neg(exportA);
  const tenantExportBEast = neg(exportBEast);
  const solarUsedB = add(bulkExportE, tenantExportA, tenantExportBEast);
  const muniUsedB = { kwh: mixedB.kwh - solarUsedB.kwh, rand: mixedB.rand - solarUsedB.rand };

  const totalMuni = add(muniA, muniBEast, mixedB);
  const totalSolar = add(solarUsedA, solarUsedBEast);
  const totalDue = add(totalMuni, totalSolar);

  return {
    key: 'skillcraft', title: 'Unit 5 SkillCraft',
    sections: [
      { heading: 'Sub E – Unit 5A (SkillCraft)', rows: [
        line('Tenant Munic Usage', '35776120', muniA),
        line('Solar Used', null, solarUsedA),
        line('Total Due', null, totalDueA, true),
        line('  Solar Production', '35775887', solarProdA),
        line('  Tenant Export', '35776120E', exportA),
      ] },
      { heading: 'Sub E – Unit 5B East (SkillCraft)', rows: [
        line('Tenant Munic Usage', '35775648', muniBEast),
        line('Solar Used', null, solarUsedBEast),
        line('Total Due', null, totalDueBEast, true),
        line('  Solar Production', '35775886', solarProdBEast),
        line('  Tenant Export', '35775648E', exportBEast),
      ] },
      { heading: 'Sub E – Unit 5B (SkillCraft, shared)', rows: [
        line('Tenant Mixed Usage', '35776119', mixedB),
        line('Total Due', null, mixedB, true),
        line('  Bulk Meter Export', '35776118E', bulkExportE),
        line('  Tenant Export from Unit 5A', null, tenantExportA),
        line('  Tenant Export from Unit 5B East', null, tenantExportBEast),
        line('Munisipal Usage', null, muniUsedB),
        line('Solar Used', null, solarUsedB),
      ] },
    ],
    total: { muniUsage: totalMuni, solarUsed: totalSolar, due: totalDue },
  };
}

// ---------- 7. JC Bakery ----------
function computeJCBakery(db, periodId, periodStart, tariff1) {
  const usageA = billedEnergy(db, '35775962', periodId, periodStart);
  const solarProdA = billedEnergy(db, '35778877', periodId, periodStart);
  const exportA = billedEnergy(db, '35775962E', periodId, periodStart);
  const solarUsedA = add(solarProdA, exportA);
  const totalDueA = add(usageA, solarUsedA);

  const usageB = billedEnergy(db, '35775964', periodId, periodStart);
  const bulkExportD = bulkExportEnergy(db, '35726713E', periodId, tariff1);
  const tenantExportA = neg(exportA);
  const solarUsedB = add(bulkExportD, tenantExportA);
  const muniUsedB = { kwh: usageB.kwh - solarUsedB.kwh, rand: usageB.rand - solarUsedB.rand };

  const totalMuni = add(usageA, usageB);
  const totalSolar = solarUsedA;
  const totalDue = add(totalMuni, totalSolar);

  return {
    key: 'jcbakery', title: 'Unit 4 JC Bakery',
    sections: [
      { heading: 'Sub D – Unit 4A (JC Bakery)', rows: [
        line('Tenant Usage', '35775962', usageA),
        line('Solar Used', null, solarUsedA),
        line('Total Due', null, totalDueA, true),
        line('  Solar Production', '35778877', solarProdA),
        line('  Tenant Export', '35775962E', exportA),
      ] },
      { heading: 'Sub D – Unit 4B (JC Bakery, shared)', rows: [
        line('Tenant Usage', '35775964', usageB),
        line('Total Due', null, usageB, true),
        line('  Bulk Meter Export', '35726713E', bulkExportD),
        line('  Tenant Export from Unit 4A', null, tenantExportA),
        line('Munisipal Usage', null, muniUsedB),
        line('Solar Used', null, solarUsedB),
      ] },
    ],
    total: { muniUsage: totalMuni, solarUsed: totalSolar, due: totalDue },
  };
}

// Returns an array of 7 solar-slip breakdowns for the given billing period, or [] if the period
// doesn't exist / has no tariff data yet.
function getSolarSlips(db, periodId) {
  const period = get(db, 'SELECT * FROM billing_periods WHERE id=?', [periodId]);
  if (!period) return [];
  const tariff1 = activeTariffParams(db, 'electricity', 1, period.start_date);
  const periodStart = period.start_date;

  const lesco = computeLesco(db, periodId, periodStart);
  return [
    computeKimo(db, periodId, periodStart),
    lesco,
    computeAgrana(db, periodId, periodStart, tariff1, lesco._exportForAgrana),
    computeHudaco(db, periodId, periodStart),
    computeTeraoka(db, periodId, periodStart, tariff1),
    computeSkillCraft(db, periodId, periodStart, tariff1),
    computeJCBakery(db, periodId, periodStart, tariff1),
  ];
}

module.exports = { getSolarSlips };
