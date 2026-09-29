// rs-farm-grassy-world/import_history.js - seeds RS-Farm - Grassy World's database with its full
// known billing history (Jul 2026 - Aug 2026), taken directly from 2 client-provided monthly
// workbooks ("RS-Farm Monthly Slip <Month> 2026 - Grassy World.xlsx"). New property added
// 2026-09-29, one of 4 loose-standing sites on RS-Farm (Grassy World, SHS, Just Trees, Main Incomer
// - see each site's own rs-farm-*/import_history.js), all sharing the TSHWANE_LV_TOU shape
// (flat_site_tariff_shapes.js - see its own header comment for the shape's full reasoning).
//
// Grassy World is the newest of the 4 sites - its first billing period (Jul 2026) is a short
// 3-day partial period (2026-07-29 to 2026-08-01, taken verbatim from the workbook's own "Range"
// line) rather than a full month, and it paid the FULL Fixed Charge that month (reading 1) rather
// than the 1/3 share SHS/Just Trees always pay - almost certainly a settling-in arrangement for its
// very first (partial) bill. From August onward it joins the same "DB-B" 1/3 split as SHS/Just
// Trees, confirmed by its August reading matching that convention exactly.
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

// Jul 2026 - Aug 2026 (Grassy World's whole known history is on this one, later rate era - it
// wasn't billed yet during the Feb-Jun 2026 RATES_A era the other 3 sites started on)
const RATES_B = {
  fixed_charge: 5432.25, network_demand: 390.78, peak_high: 7.8136, peak_low: 3.21,
  standard_high: 2.9945, standard_low: 2.02, offpeak_high: 1.7145, offpeak_low: 1.43,
};

// label, start_date, end_date, effective_from, fixedChargeReading, demandKva, demandComment,
// peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow
const MONTHS = [
  ['2026-07', '2026-07-29', '2026-08-01', '2026-07-01', 1, 25.9834, '2026/07/30 14:00', 10.326, 0, 147.999, 0, 0.125, 0],
  ['2026-08', '2026-08-01', '2026-09-01', '2026-07-01', 1 / 3, 46.510148, '2026/08/27 16:00', 139.839481498885, 0, 1629.29199055136, 0, 411.851792605479, 0],
];

function main(dbFile = 'rs-farm-grassy-world.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for RS-Farm - Grassy World.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, fixedReading, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: TSHWANE_LV_TOU, rates: RATES_B, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        fixed_charge: fixedReading,
        network_demand: { reading: kva, comment },
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`RS-Farm - Grassy World history import: ${created} month(s) added (Jul 2026 - Aug 2026).`);
  return db;
}

module.exports = { run: main };
