// rs-farm-main-incomer/import_history.js - seeds RS-Farm - Main Incomer's database with its full
// known billing history (May 2026 - Aug 2026), taken directly from 4 client-provided monthly
// workbooks ("RS-Farm Monthly Slip <Month> 2026 - Main Incomer.xlsx"). New property added
// 2026-09-29, one of 4 loose-standing sites on RS-Farm (Grassy World, SHS, Just Trees, Main Incomer
// - see each site's own rs-farm-*/import_history.js), all sharing the TSHWANE_LV_TOU shape
// (flat_site_tariff_shapes.js - see its own header comment for the shape's full reasoning).
//
// Unlike SHS/Just Trees (and Grassy World from August on), Main Incomer pays the FULL Fixed Charge
// every month (reading 1, not 1/3) - it's the farm's own overall connection, not a share of the
// "DB-B" sub-board the other 3 sites split between them.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff/seedSlip are
// all idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { TSHWANE_LV_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

// No correction-factor system applies here (every line item's factorType is null - see the shape's
// own comment) - kept at 1 purely so seedTariff has something to store in site_tariffs' NOT NULL
// factor columns.
const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'Tshwane_LV_TOU_RS-Farm';

// May 2026 - Jun 2026
const RATES_A = {
  fixed_charge: 4992.88, network_demand: 359.17, peak_high: 7.1816, peak_low: 2.9499,
  standard_high: 2.7523, standard_low: 1.8577, offpeak_high: 1.5758, offpeak_low: 1.3155,
  water: 0, sewer: 0,
};
// Jul 2026 - Aug 2026
const RATES_B = {
  fixed_charge: 5432.25, network_demand: 390.78, peak_high: 7.8136, peak_low: 3.21,
  standard_high: 2.9945, standard_low: 2.02, offpeak_high: 1.7145, offpeak_low: 1.43,
  water: 0, sewer: 0,
};

// label, start_date, end_date, effective_from, rates, demandKva, demandComment,
// peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow
const MONTHS = [
  ['2026-05', '2026-05-01', '2026-06-01', '2026-05-01', RATES_A, 101.748062, '2026/05/13 14:30', 0, 719.8714, 0, 4819.36175, 0, 2031.3036],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-05-01', RATES_A, 88.459912, '2026/06/09 12:30', 414.5628, 0, 7143.39933, 0, 1546.55226, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_B, 96.291568, '2026/07/03 11:30', 561.180845, 0, 6943.43707, 0, 1847.23066, 0],
  ['2026-08', '2026-08-01', '2026-09-01', '2026-07-01', RATES_B, 90.669754, '2026/08/06 12:30', 661.5845, 0, 7143.02918, 0, 2261.714, 0],
];

function main(dbFile = 'rs-farm-main-incomer.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for RS-Farm - Main Incomer.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: TSHWANE_LV_TOU, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        fixed_charge: 1,
        network_demand: { reading: kva, comment },
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`RS-Farm - Main Incomer history import: ${created} month(s) added (May 2026 - Aug 2026).`);
  return db;
}

module.exports = { run: main };
