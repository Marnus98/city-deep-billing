// zelvio-global/seed.js - seeds 55 Loper Ave - Zelvio Global's database with its first tariff
// version and its first billing slip (July 2026), taken from the client's own workbook ("55 Loper -
// Zelvio Global - July 2026.xlsx", Ekurhuleni Tariff B (<=150A)) - a loose-standing flat_site
// property, same model as 8 Field Street / adh-machine-tool. Same "Loper Ave" tenant template as
// adh-machine-tool (see flat_site_tariff_shapes.js's EKURHULENI_TARIFF_B header comment for the
// shared-template formula quirks found across all 5 sites on this template). Safe to re-run: both
// inserts are idempotent (see flat_site_seed_helpers.js).
//
// Billing period: "Range: 17 June 2026 - 03 Aug 2026" (47 days), identical to adh-machine-tool's own
// first period - same reading cycle, same building. Labelled '2026-07' (July has 31 of the 47 days).
//
// Rates (100.23 basic, 3.7982/3.0949 energy, 28.96 capacity, 54.51 water, 0.682 common area, 22.07
// sewer) are taken straight from the workbook's own Tariffs tab (2026/2027 column) - correct, and
// what future months on this tariff version should use.
//
// Readings for capacity_charge/water/water_common_area/sewer/sewer_common_area are back-solved (not
// the workbook's own Reading column) so Reading x Rate reproduces this workbook's own Cost column
// exactly, preserving its R20,661.86 Sub Total (Excl VAT) - same 2026-08-20 client decision as
// adh-machine-tool. Only this slip's readings carry the adjustment; the tariff's rates stay clean.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_TARIFF_B } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

function main(dbFile = 'zelvio-global.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');

  const tariffId = seedTariff(db, {
    tariffName: 'Ekurhuleni_Tariff_B_Zelvio Global',
    effectiveFrom: '2026-07-01',
    shape: EKURHULENI_TARIFF_B,
    rates: {
      basic_charge: 100.23, energy_high: 3.7982, energy_low: 3.0949, capacity_charge: 28.96,
      water: 54.51, water_common_area: 0.682, sewer: 22.07, sewer_common_area: 0.682,
    },
    factors: FACTORS,
    notes: 'Initial tariff, taken from the client-provided "55 Loper - Zelvio Global - July 2026.xlsx" '
      + 'workbook (Ekurhuleni_ Tariff B (<=150A)), 2026/2027 tariff-year column, effective 2026-07-01.',
  });

  seedSlip(db, tariffId, {
    label: '2026-07', startDate: '2026-06-17', endDate: '2026-08-03', applyCorrectionFactor: 0,
    readings: {
      basic_charge: 1,
      energy_high: 1617, energy_low: 0,
      // Back-solved: 450 x 28.96 = R13,032.00, matching the workbook's own Cost cell (its Reading
      // column shows 150A).
      capacity_charge: 450,
      // Back-solved: 17.691673 x 54.51 = R964.37 (workbook's own Cost cell; its Reading column shows
      // the true 19.637kL reading, but its Cost formula used last year's 49.11 rate instead).
      water: 17.691673,
      // Back-solved: 54.51 x 0.682 = R37.18 (workbook's own Cost cell; its formula appears to have
      // used this year's water rate, 54.51, in place of the actual reading).
      water_common_area: 54.51,
      // Back-solved: 16.825359 x 22.07 = R371.34 (workbook's own Cost cell; used last year's 18.91
      // sewer rate instead of this year's 22.07).
      sewer: 16.825359,
      // Back-solved: 22.07 x 0.682 = R15.05 (same "rate used as reading" quirk as water_common_area).
      sewer_common_area: 22.07,
    },
  });

  console.log('55 Loper Ave - Zelvio Global: seeded initial tariff + July 2026 billing slip.');
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
