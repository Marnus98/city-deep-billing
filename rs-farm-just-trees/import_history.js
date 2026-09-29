// rs-farm-just-trees/import_history.js - seeds RS-Farm - Just Trees's database with its full known
// billing history (Jun 2026 - Aug 2026), taken directly from 3 client-provided monthly workbooks
// ("RS-Farm Monthly Slip <Month> 2026 - Just Trees.xlsx" - the "Billing Slip - Just Trees" tab
// specifically; these workbooks also carry several raw-data/pivot/TOU tabs not needed here). New
// property added 2026-09-29, one of 4 loose-standing sites on RS-Farm (Grassy World, SHS, Just
// Trees, Main Incomer - see each site's own rs-farm-*/import_history.js), all sharing the
// TSHWANE_LV_TOU shape (flat_site_tariff_shapes.js - see its own header comment for the shape's
// full reasoning).
//
// Just Trees shares a "DB-B" sub-board with SHS (and Grassy World from August on) and pays exactly
// 1/3 of the Fixed Charge every month (reading 0.3333...) - confirmed identical rates every month
// against Main Incomer/SHS/Grassy World's own workbooks for the same period, so this is genuinely
// one shared municipal tariff across all 4 sites, not 4 independent ones.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff/seedSlip are
// all idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { TSHWANE_LV_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip, pruneTariffItemKeys } = require('../flat_site_seed_helpers');

// No correction-factor system applies here (every line item's factorType is null - see the shape's
// own comment) - kept at 1 purely so seedTariff has something to store in site_tariffs' NOT NULL
// factor columns.
const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'Tshwane_LV_TOU_RS-Farm';

// Jun 2026
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
  ['2026-06', '2026-06-01', '2026-07-01', '2026-06-01', RATES_A, 17.632742, '2026/06/06 11:30', 4.387999999999997, 0, 838.6619999999949, 0, 68.43000000000104, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_B, 15.041756, '2026/07/06 10:30', 4.319999999999996, 0, 1013.3999999999959, 0, 148.20000000000186, 0],
  ['2026-08', '2026-08-01', '2026-09-01', '2026-07-01', RATES_B, 19.148472, '2026/08/17 11:00', 21.92, 0, 1242.28, 0, 331.799999999999, 0],
];

function main(dbFile = 'rs-farm-just-trees.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for RS-Farm - Just Trees.');
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
  if (created) console.log(`RS-Farm - Just Trees history import: ${created} month(s) added (Jun 2026 - Aug 2026).`);
  // One-time cleanup for the 2026-09-29 water/sewer removal (see flat_site_seed_helpers.js's
  // pruneTariffItemKeys comment) - a live deploy may have already seeded this tariff WITH
  // water/sewer before the shape was corrected, and seedTariff's idempotency means re-running it
  // alone would never remove those stale rows.
  const pruned = pruneTariffItemKeys(db, { tariffName: TARIFF_NAME, keys: ['water', 'sewer'] });
  if (pruned) console.log(`RS-Farm - Just Trees: pruned ${pruned} stale water/sewer tariff item(s).`);
  return db;
}

module.exports = { run: main };
