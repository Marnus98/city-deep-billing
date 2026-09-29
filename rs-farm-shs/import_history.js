// rs-farm-shs/import_history.js - seeds RS-Farm - SHS's database with its full known billing
// history (Feb 2026 - Aug 2026), taken directly from 7 client-provided monthly workbooks
// ("RS-Farm Monthly Slip <Month> 2026 - SHS.xlsx"). New property added 2026-09-29, one of 4
// loose-standing sites on RS-Farm (Grassy World, SHS, Just Trees, Main Incomer - see each site's own
// rs-farm-*/import_history.js), all sharing the TSHWANE_LV_TOU shape (flat_site_tariff_shapes.js -
// see its own header comment for the shape's full reasoning).
//
// SHS shares a "DB-B" sub-board with Just Trees (and Grassy World from August on) and pays exactly
// 1/3 of the Fixed Charge every month (reading 0.3333...) - confirmed identical rates every month
// against Main Incomer/Just Trees/Grassy World's own workbooks for the same period, so this is
// genuinely one shared municipal tariff across all 4 sites, not 4 independent ones.
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

// Feb 2026 - Jun 2026
const RATES_A = {
  fixed_charge: 4992.88, network_demand: 359.17, peak_high: 7.1816, peak_low: 2.9499,
  standard_high: 2.7523, standard_low: 1.8577, offpeak_high: 1.5758, offpeak_low: 1.3155,
};
// Jul 2026 - Aug 2026
const RATES_B = {
  fixed_charge: 5432.25, network_demand: 390.78, peak_high: 7.8136, peak_low: 3.21,
  standard_high: 2.9945, standard_low: 2.02, offpeak_high: 1.7145, offpeak_low: 1.43,
};

// label, start_date, end_date, effective_from, rates, demandKva, demandComment,
// peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow
const MONTHS = [
  ['2026-02', '2026-02-19', '2026-03-01', '2026-02-01', RATES_A, 7.649946, '2026/02/23 11:00', 0, 59.659, 0, 160.854, 0, 182.085],
  ['2026-03', '2026-03-01', '2026-04-01', '2026-02-01', RATES_A, 16.431254, '2026/03/26 16:00', 0, 478.398993458, 0, 1235.767492408, 0, 848.470514142],
  ['2026-04', '2026-04-01', '2026-05-01', '2026-02-01', RATES_A, 17.340196, '2026/04/02 11:00', 0, 805.32, 0, 1978.548, 0, 1710.05],
  ['2026-05', '2026-05-01', '2026-06-01', '2026-02-01', RATES_A, 27.186276, '2026/05/22 12:00', 0, 581.92, 0, 1925.499, 0, 1122.275],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-02-01', RATES_A, 27.245766, '2026/06/26 10:30', 377.899411108776, 0, 2589.4193907218, 0, 899.10619819804, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_B, 29.45379, '2026/07/03 08:30', 397.988330323341, 0, 2460.34353057676, 0, 872.14887759123, 0],
  ['2026-08', '2026-08-01', '2026-09-01', '2026-07-01', RATES_B, 27.450412, '2026/08/17 08:30', 422.328, 0, 2795.702, 0, 1067.51, 0],
];

function main(dbFile = 'rs-farm-shs.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for RS-Farm - SHS.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: TSHWANE_LV_TOU, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        fixed_charge: 1 / 3,
        network_demand: { reading: kva, comment },
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`RS-Farm - SHS history import: ${created} month(s) added (Feb 2026 - Aug 2026).`);
  return db;
}

module.exports = { run: main };
