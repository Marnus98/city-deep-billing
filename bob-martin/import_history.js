// bob-martin/import_history.js - seeds Bob Martin's database with its full known billing history
// (July 2025 - July 2026), taken directly from the client-provided workbook "Other Sites - Past
// billing.xlsx" (tab 'Bob Martin'). Same Ekurhuleni Tariff E TOU shape as 8 Field Street (see
// flat_site_tariff_shapes.js) - just its own rates. Combines what field-street splits into
// seed.js + import_history.js into one script, since here every month (including the most recent)
// comes from the same source workbook rather than a separate reference statement.
//
// Correction factors: per the client's instruction, reusing the same 4 factor constants already
// applied to 8 Field Street "for now" - not yet confirmed against Bob Martin's own meters.
//
// Water/Sewer: not billed through this app for this site yet (rate 0, unused) - same as every
// other flat_site property until the client adds readings via the Edit page.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff/seedSlip are
// all idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_E_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

const TARIFF_NAME = 'Ekurhuleni_Tariff_E_TOU_Bob Martin';

// Three rate versions found across the 13 months - Jul 2025 - Jan 2026, Feb 2026 - Jun 2026, and
// Jul 2026 (each taken verbatim from that month's statement).
const RATES_A = { // Jul 2025 - Jan 2026
  fixed_charge: 3351.2638, network_access: 114.9369, network_demand: 171.0979,
  peak_high: 11.6178, peak_low: 3.7833, standard_high: 3.3634, standard_low: 2.4736,
  offpeak_high: 2.0632, offpeak_low: 1.8774, water: 0, sewer: 0,
};
const RATES_B = { // Feb 2026 - Jun 2026
  fixed_charge: 3069.24, network_access: 105.9466, network_demand: 158.13,
  peak_high: 10.8065, peak_low: 3.561, standard_high: 3.1578, standard_low: 2.343,
  offpeak_high: 1.9508, offpeak_low: 1.788, water: 0, sewer: 0,
};
const RATES_C = { // Jul 2026
  fixed_charge: 3599.88, network_access: 131.43, network_demand: 153.36,
  peak_high: 7.7211, peak_low: 3.5769, standard_high: 2.4079, standard_low: 2.29,
  offpeak_high: 1.8176, offpeak_low: 1.8176, water: 0, sewer: 0,
};

// label, start_date, end_date, effective_from, rates, network_kva, comment, peak_high, peak_low,
// standard_high, standard_low, offpeak_high, offpeak_low. High/Low Demand Season readings mirror
// the actual statements exactly (winter months bill under "High Demand", the rest "Low Demand").
const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 528.175364, '2025/07/29 21:30', 28223.6351447917, 0, 74660.8598848415, 0, 50384.2054203809, 0],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 508.316212, '2025/08/12 08:00', 18278.5870271508, 0, 47168.4827068183, 0, 30844.2690152682, 0],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 500.437716, '2025/09/04 13:30', 0, 26062.458, 0, 63878.5578000001, 0, 41023.53395],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 501.096892, '2025/10/02 10:00', 0, 28457.7575, 0, 66334.0511, 0, 45284.3338],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 502.225686, '2025/11/17 13:00', 0, 25485.9732, 0, 57356.8576816883, 0, 43445.0408683316],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 477.251804, '2025/12/04 11:30', 0, 6526.39777605384, 0, 17419.2371468466, 0, 14821.5592184425],
  ['2026-01', '2026-01-01', '2026-02-01', '2025-07-01', RATES_A, 481.275392, '2026/01/19 10:30', 0, 17884.6435, 0, 46413.54605, 0, 30922.9418000202],
  ['2026-02', '2026-02-01', '2026-03-01', '2026-02-01', RATES_B, 469.10536, '2026/02/24 19:00', 0, 19939.81285, 0, 50496.8492, 0, 31235.03715],
  ['2026-03', '2026-03-01', '2026-04-01', '2026-02-01', RATES_B, 468.285038, '2026/03/10 14:00', 0, 26660.4399, 0, 59486.0511, 0, 39477.6963],
  ['2026-04', '2026-04-01', '2026-05-01', '2026-02-01', RATES_B, 490.549758, '2026/04/14 13:00', 0, 13599.03755, 0, 32875.93765, 0, 23740.7988],
  ['2026-05', '2026-05-01', '2026-06-01', '2026-02-01', RATES_B, 492.127656, '2026/05/20 21:00', 0, 20775.66345, 0, 48561.085645, 0, 32975.861475],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-02-01', RATES_B, 493.677632, '2026/06/02 21:30', 23917.9965, 0, 59264.60515, 0, 40124.4455, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_C, 487.472484, '2026/07/22 20:30', 20906.18375, 0, 49575.36595, 0, 36845.7267, 0],
];

function main(dbFile = 'bob-martin.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for Bob Martin.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: EKURHULENI_E_TOU, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        network_access: { reading: kva, comment }, network_demand: { reading: kva, comment },
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`Bob Martin history import: ${created} month(s) added (Jul 2025 - Jul 2026).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
