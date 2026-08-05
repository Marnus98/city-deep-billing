// field-street/import_history.js - one-time bulk import of 8 Field Street's electricity billing
// history (July 2025 - June 2026), taken directly from the client-provided workbook
// "8 field test - past billing.xlsx" (12 monthly "8 Field Street Main Electrical" statements, same
// Ekurhuleni TOU format as the reference image seed.js was built from). July 2026 onward is already
// covered by seed.js / the live "Add Billing Slip" form, so this script stops at June 2026.
//
// Water/Sewer are deliberately left at 0 here - the client is adding those manually via the
// Edit page on the live site once this import lands, so this script only ever touches the
// electricity fields, never overwrites water_kl/sewer_kl on a slip that already exists.
//
// Safe to re-run on every boot (same pattern as seed_municipal.js): each month is looked up by its
// unique label ('2025-07' etc) and skipped if already present, so redeploying never duplicates or
// clobbers a slip the client has since edited by hand.
const { open, migrate } = require('../db');

let db;
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }

const TARIFF_FIELDS = [
  'fixed_charge_rate', 'network_access_rate', 'network_demand_rate',
  'peak_high_rate', 'peak_low_rate', 'standard_high_rate', 'standard_low_rate',
  'offpeak_high_rate', 'offpeak_low_rate', 'water_rate', 'sewer_rate',
  'kva_factor', 'peak_factor', 'standard_factor', 'offpeak_factor',
];

// Same site-meter-vs-municipal-meter correction factors used everywhere else for this site - the
// meters haven't been recalibrated, these historical months just happen to be entered from the
// municipality's own statement (see apply_correction_factor below), not our own meter dial.
const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

// Two rate versions found across the 12 months - the tariff changed once, effective Feb 2026.
const TARIFF_A = { // Jul 2025 - Jan 2026
  effective_from: '2025-07-01',
  fixed_charge_rate: 5694.3279, network_access_rate: 107.5628, network_demand_rate: 161.8608,
  peak_high_rate: 11.4252, peak_low_rate: 3.7132, standard_high_rate: 3.3047, standard_low_rate: 2.4231,
  offpeak_high_rate: 2.0192, offpeak_low_rate: 1.8357, water_rate: 0, sewer_rate: 0, ...FACTORS,
};
const TARIFF_B = { // Feb 2026 - Jun 2026
  effective_from: '2026-02-01',
  fixed_charge_rate: 5207.09, network_access_rate: 105.9466, network_demand_rate: 146.09,
  peak_high_rate: 10.486, peak_low_rate: 3.415, standard_high_rate: 3.036, standard_low_rate: 2.231,
  offpeak_high_rate: 1.848, offpeak_low_rate: 1.693, water_rate: 0, sewer_rate: 0, ...FACTORS,
};

// label, start_date, end_date, tariff, network_kva, comment, peak_high, peak_low, standard_high,
// standard_low, offpeak_high, offpeak_low. High/Low Demand Season readings mirror the actual
// statements exactly (winter months bill under "High Demand", the rest under "Low Demand").
const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', TARIFF_A, 587.576762, '2025/07/11 07:00', 47510.48, 0, 99886.55, 0, 115380.42, 0],
  ['2025-08', '2025-08-01', '2025-09-01', TARIFF_A, 590.287186, '2025/08/13 21:00', 38622.49, 0, 84308.26, 0, 122621.9, 0],
  ['2025-09', '2025-09-01', '2025-10-01', TARIFF_A, 600.921836, '2025/09/10 22:00', 0, 46140.52, 0, 107174.03, 0, 147138.53],
  ['2025-10', '2025-10-01', '2025-11-01', TARIFF_A, 592.437368, '2025/10/22 21:00', 0, 49665.88, 0, 107005.79, 0, 138035.11],
  ['2025-11', '2025-11-01', '2025-12-01', TARIFF_A, 587.63589, '2025/11/27 20:30', 0, 40347.68, 0, 93869.99, 0, 125695.44],
  ['2025-12', '2025-12-01', '2026-01-01', TARIFF_A, 576.463398, '2025/12/04 20:00', 0, 30983.01, 0, 76012.39, 0, 108748.62],
  ['2026-01', '2026-01-01', '2026-02-01', TARIFF_A, 595.787268, '2026/01/29 22:00', 0, 40917.38, 0, 88116.32, 0, 113724.34],
  ['2026-02', '2026-02-01', '2026-03-01', TARIFF_B, 569.79913, '2026/02/10 19:00', 0, 37054.89, 0, 78921.15, 0, 102771.76],
  ['2026-03', '2026-03-01', '2026-04-01', TARIFF_B, 608.312344, '2026/03/10 21:30', 0, 42599.81, 0, 92221.79, 0, 117336],
  ['2026-04', '2026-04-01', '2026-05-01', TARIFF_B, 596.817086, '2026/04/29 07:00', 0, 41631.11, 0, 95711.72, 0, 139319.34],
  ['2026-05', '2026-05-01', '2026-06-01', TARIFF_B, 594.15233, '2026/05/07 21:30', 0, 45649.32, 0, 103848.27, 0, 139985.44],
  ['2026-06', '2026-06-01', '2026-07-01', TARIFF_B, 580.191224, '2026/06/04 21:30', 41161.79, 0, 93587.11, 0, 114716.57, 0],
];

function findOrCreateTariff(fields) {
  const existing = all('SELECT * FROM site_tariffs ORDER BY id DESC');
  const match = existing.find((t) => TARIFF_FIELDS.every((c) => Math.abs((t[c] || 0) - (Number(fields[c]) || 0)) < 1e-9));
  if (match) return match.id;
  const cols = TARIFF_FIELDS.join(', ');
  const placeholders = TARIFF_FIELDS.map(() => '?').join(',');
  run(`INSERT INTO site_tariffs (effective_from, ${cols}) VALUES (?, ${placeholders})`,
    [fields.effective_from, ...TARIFF_FIELDS.map((c) => Number(fields[c]) || 0)]);
  return get('SELECT id FROM site_tariffs ORDER BY id DESC LIMIT 1').id;
}

function main(dbFile = 'field-street.db') {
  db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const [label, startDate, endDate, tariffFields, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow] of MONTHS) {
    if (get('SELECT id FROM site_billing_slips WHERE label=?', [label])) continue;
    const tariffId = findOrCreateTariff(tariffFields);
    run(`INSERT INTO site_billing_slips (
        label, start_date, end_date, tariff_id,
        network_access_kva, network_access_comment, network_demand_kva, network_demand_comment,
        peak_high_kwh, peak_low_kwh, standard_high_kwh, standard_low_kwh,
        offpeak_high_kwh, offpeak_low_kwh, water_kl, sewer_kl, apply_correction_factor, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [label, startDate, endDate, tariffId, kva, comment, kva, comment,
        peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow, 0, 0, 1, 'finalised']);
    created++;
  }
  if (created) console.log(`8 Field Street history import: ${created} month(s) added (Jul 2025 - Jun 2026).`);
  return db;
}

if (require.main === module) { main(); db.close(); }
module.exports = { run: main };
