// loper-road/import_history.js - seeds Loper Road - Sandvic's database with its known billing
// history (July 2025 - June 2026), taken directly from the client-provided workbook "Other Sites -
// Past billing.xlsx" (tab 'Loper Road - Sandvic'). Uses the Ekurhuleni Industrial Tariff C shape
// (see flat_site_tariff_shapes.js) - a genuinely different tariff from 8 Field Street/Bob
// Martin/Cranbrook's Ekurhuleni Tariff E TOU (Basic Charge not Fixed Charge, one Demand Charge
// instead of split Network Access/Network Demand, High-demand energy rows grouped before Low-
// demand rows).
//
// Two source-data issues resolved here rather than imported verbatim:
// 1. The workbook has two blocks both labelled "2025-11". Cross-referencing the embedded max-
//    demand read-date comments (first block: "2025/11/10", second: "2025/12/17") confirms the
//    second block is actually December 2025, mislabelled in the source file - imported here as
//    '2025-12'.
// 2. July 2026 uses a collapsed "Total Energy - High/Low Demand" format instead of the detailed
//    Peak/Standard/Off-Peak split used every other month - structurally incompatible with this
//    site's line-item shape, so it is deliberately NOT imported. The site's history here stops at
//    June 2026; July 2026 onward can be entered via the live "Add Billing Slip" form once the
//    client confirms how that statement should be broken down.
//
// Correction factors: per the client's instruction, reusing the same 4 factor constants already
// applied to 8 Field Street "for now" (Demand Charge gets the kva factor here, same as Network
// Demand does for the E TOU shape).
//
// Water/Sewer: not billed through this app for this site yet (rate 0, unused).
//
// Safe to re-run on every boot - see flat_site_seed_helpers.js.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_INDUSTRIAL_C } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

const TARIFF_NAME = 'Ekurhuleni_Industrial_Tariff_C_Loper Road - Sandvic';

// Single rate era across all 12 importable months (Jul 2025 - Jun 2026) - no tariff change seen in
// this window.
const RATES_A = {
  basic_charge: 3700.6031, peak_high: 5.0184, standard_high: 3.9559, offpeak_high: 3.8378,
  peak_low: 2.8086, standard_low: 2.5512, offpeak_low: 2.4567,
  network_access: 110.9399, demand_charge: 299.463, water: 0, sewer: 0,
};

// label, start_date, end_date, effective_from, rates, network_kva, comment, peak_high, standard_high,
// offpeak_high, peak_low, standard_low, offpeak_low (row order matches the Industrial C shape:
// High-demand trio first, then Low-demand trio).
const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 31.777022, '2025/07/22 07:30', 1073.802, 3186.35, 750.969999999999, 0, 0, 0],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 36.43038, '2025/08/07 14:00', 851.257, 2727.735, 702.008999999999, 0, 0, 0],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 26.368, '2025/09/25 13:30', 0, 0, 0, 874.755, 2945.478, 741.923],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 29.896766, '2025/10/15 15:30', 0, 0, 0, 901.996, 3162.458, 671.796],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 27.188026, '2025/11/10 08:00', 0, 0, 0, 806.525, 2855.1034, 893.009000000002],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 26.468668, '2025/12/17 14:30', 0, 0, 0, 461.912387475358, 1608.47479380373, 710.006410768961],
  ['2026-01', '2026-01-01', '2026-02-01', '2025-07-01', RATES_A, 26.339624, '2026/01/27 14:30', 0, 0, 0, 548.5133173254736, 2122.3468922759153, 625.0937904030559],
  ['2026-02', '2026-02-01', '2026-03-01', '2025-07-01', RATES_A, 26.062024, '2026/02/20 10:00', 0, 0, 0, 852.643829478792, 3119.71082610326, 691.895075202928],
  ['2026-03', '2026-03-01', '2026-04-01', '2025-07-01', RATES_A, 26.812024, '2026/03/19 15:00', 0, 0, 0, 823.7, 3043.033, 773.688],
  ['2026-04', '2026-04-01', '2026-05-01', '2025-07-01', RATES_A, 22.688, '2026/04/21 14:30', 0, 0, 0, 746.14, 2566.488, 841.301000000001],
  ['2026-05', '2026-05-01', '2026-06-01', '2025-07-01', RATES_A, 27.936, '2026/05/22 09:00', 0, 0, 0, 867.965, 3064.527, 910.219000000001],
  ['2026-06', '2026-06-01', '2026-07-01', '2025-07-01', RATES_A, 31.236, '2026/06/29 12:00', 816.300000000001, 3012.64, 628.029, 0, 0, 0],
];

function main(dbFile = 'loper-road.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for Loper Road - Sandvic.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, peakHigh, stdHigh, offHigh, peakLow, stdLow, offLow] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: EKURHULENI_INDUSTRIAL_C, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        network_access: { reading: kva, comment }, demand_charge: { reading: kva, comment },
        peak_high: peakHigh, standard_high: stdHigh, offpeak_high: offHigh,
        peak_low: peakLow, standard_low: stdLow, offpeak_low: offLow,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`Loper Road - Sandvic history import: ${created} month(s) added (Jul 2025 - Jun 2026).`);

  // The client doesn't want the site-meter correction factor applied to any historical import -
  // it should only ever be ticked deliberately, per month, on new slips added going forward via
  // the live "Add Billing Slip" form (default unticked there too - see views.js). Runs
  // unconditionally every boot; a no-op once every slip is already off.
  db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0').run();

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
