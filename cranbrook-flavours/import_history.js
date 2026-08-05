// cranbrook-flavours/import_history.js - seeds Cranbrook Flavours' database with its full known
// billing history (July 2025 - July 2026), taken directly from the client-provided workbook
// "Other Sites - Past billing.xlsx" (tab 'Cranbrook Flavours'). Same Ekurhuleni Tariff E TOU shape
// as 8 Field Street (see flat_site_tariff_shapes.js) - rates for Jul 2025 - Jun 2026 happen to be
// numerically identical to 8 Field Street's own RATES_A for the same period (same municipal
// tariff, same era), Jul 2026 is its own site-specific rate (client statement labels the fixed fee
// "Service Charge" that month instead of "Fixed Charge", but it's the same tariff item/key).
//
// Correction factors: per the client's instruction, reusing the same 4 factor constants already
// applied to 8 Field Street "for now".
//
// Water/Sewer: not billed through this app for this site yet (rate 0, unused).
//
// Safe to re-run on every boot - see flat_site_seed_helpers.js.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_E_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

const TARIFF_NAME = 'Ekurhuleni_Tariff_E_TOU_Cranbrook Flavours';

// Two rate versions - Jul 2025 - Jun 2026, then Jul 2026.
const RATES_A = { // Jul 2025 - Jun 2026
  fixed_charge: 5694.3279, network_access: 107.5628, network_demand: 161.8608,
  peak_high: 11.4252, peak_low: 3.7132, standard_high: 3.3047, standard_low: 2.4231,
  offpeak_high: 2.0192, offpeak_low: 1.8357, water: 0, sewer: 0,
};
const RATES_B = { // Jul 2026
  fixed_charge: 5676.25, network_access: 105.33, network_demand: 159.25,
  peak_high: 11.4354, peak_low: 3.7227, standard_high: 3.3142, standard_low: 2.4324,
  offpeak_high: 2.0286, offpeak_low: 1.8451, water: 0, sewer: 0,
};

const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 92.254426, '2025/07/23 10:30', 565.472, 0, 3312.7849, 0, 973.086300000001, 0],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 60.279304, '2025/08/01 10:30', 450.51785, 0, 2678.99015, 0, 983.0612, 0],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 85.348078, '2025/09/23 13:00', 0, 599.62815, 0, 3050.64975, 0, 892.036730000001],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 71.393448, '2025/10/14 10:00', 0, 532.61365, 0, 2877.8943, 0, 876.733249999999],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 78.706928, '2025/11/05 10:00', 0, 649.17675, 0, 3032.14375, 0, 982.2294],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 37.035944, '2026/01/08 09:30', 0, 188.01175, 0, 626.1455, 0, 595.77628],
  ['2026-01', '2026-01-01', '2026-02-01', '2025-07-01', RATES_A, 41.823744, '2026/01/15 09:30', 0, 463.36855, 0, 1425.81625, 0, 665.66125],
  ['2026-02', '2026-02-01', '2026-03-01', '2025-07-01', RATES_A, 54.038514, '2026/02/07 10:00', 0, 644.0784, 0, 2037.9676, 0, 982.4456],
  ['2026-03', '2026-03-01', '2026-04-01', '2025-07-01', RATES_A, 52.562974, '2026/03/19 15:30', 0, 579.4178, 0, 2345.284505, 0, 994.4723],
  ['2026-04', '2026-04-01', '2026-05-01', '2025-07-01', RATES_A, 53.474346, '2026/04/10 10:00', 0, 589.222, 0, 2007.9469, 0, 733.21535],
  ['2026-05', '2026-05-01', '2026-06-01', '2025-07-01', RATES_A, 49.427456, '2026/05/15 13:30', 0, 593.249, 0, 2267.4834, 0, 778.807350000001],
  ['2026-06', '2026-06-01', '2026-07-01', '2025-07-01', RATES_A, 55.521416, '2026/06/10 13:30', 480.5944, 0, 2497.2823, 0, 673.69355, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_B, 60.450586, '2026/07/14 14:30', 481.7269, 0, 2495.0006, 0, 669.00425, 0],
];

function main(dbFile = 'cranbrook-flavours.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for Cranbrook Flavours.');
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
  if (created) console.log(`Cranbrook Flavours history import: ${created} month(s) added (Jul 2025 - Jul 2026).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
