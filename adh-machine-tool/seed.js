// adh-machine-tool/seed.js - seeds 55 Loper Ave - ADH Machine Tool South Africa (PTY) Ltd's database
// with its first tariff version and its first billing slip (July 2026), taken directly from the
// client's own workbook ("55 Loper - ADH Machine Tool - July 2026.xlsx", Ekurhuleni Tariff B
// (<=150A)) - a genuinely new loose-standing flat_site property, the same model as 8 Field Street.
// The client will upload a new month's workbook (plus the real municipal account statement, once
// received) each month going forward - those become their own import_history.js/municipal_import.js
// once more than this first month exists, following field-street/'s pattern. Safe to re-run: both
// inserts are idempotent (see flat_site_seed_helpers.js).
//
// Billing period: the workbook's own "Range: 17 June 2026 - 03 Aug 2026" (47 days) - unusually long
// because the prior reading cycle (28 Apr - 27 May 2026) wasn't followed by a 27 May - 17 Jun read;
// the next reading on file jumps straight to 17 Jun, so this first slip covers the full 17 Jun - 3
// Aug gap in one go. Labelled '2026-07' (July has 31 of the 47 days, the clear majority-consumption
// month, matching this app's billing_periods.label convention used everywhere else).
//
// Reading vs. Rate: every rate below (100.23 basic, 3.7982/3.0949 energy, 28.96 capacity, 54.51
// water, 0.542 common area, 22.07 sewer) is taken straight from the workbook's own Tariffs tab
// (2026/2027 column) and matches what the Billing Slip tab's Rate column shows - these are correct
// and are what future months on this tariff version should use too.
//
// The *readings* below for capacity_charge/water/water_common_area/sewer/sewer_common_area are NOT
// what the workbook's own Reading column shows (80A / 4.9931kL for all four water/sewer lines) -
// they're back-solved so Reading x Rate reproduces this workbook's own (buggy-formula) Cost column
// exactly, preserving its R8,822.48 Sub Total (Excl VAT) bottom line, per the client's own choice
// 2026-08-20 (see flat_site_tariff_shapes.js's EKURHULENI_TARIFF_B header comment for the full
// explanation of which Cost cells didn't equal Rate x Reading in the source workbook and why). Only
// this one slip's readings carry the adjustment - the tariff's rates stay clean, so a future month
// seeded normally (real reading x this same rate) won't inherit this month's one-off glitch.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_TARIFF_B } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

// No site-vs-municipal meter accuracy history yet for a brand new site - factors of 1 are a no-op
// even if the correction-factor checkbox is ever ticked on for this slip (which it isn't, see
// applyCorrectionFactor: 0 below, matching this app's global default - see README/task history on
// "Turn off correction factor for all historical slips, all properties").
const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

function main(dbFile = 'adh-machine-tool.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');

  const tariffId = seedTariff(db, {
    tariffName: 'Ekurhuleni_Tariff_B_ADH Machine Tool',
    effectiveFrom: '2026-07-01',
    shape: EKURHULENI_TARIFF_B,
    rates: {
      basic_charge: 100.23, energy_high: 3.7982, energy_low: 3.0949, capacity_charge: 28.96,
      water: 54.51, water_common_area: 0.542, sewer: 22.07, sewer_common_area: 0.542,
    },
    factors: FACTORS,
    notes: 'Initial tariff, taken from the client-provided "55 Loper - ADH Machine Tool - July 2026.xlsx" '
      + 'workbook (Ekurhuleni_ Tariff B (<=150A)), 2026/2027 tariff-year column, effective 2026-07-01.',
  });

  seedSlip(db, tariffId, {
    label: '2026-07', startDate: '2026-06-17', endDate: '2026-08-03', applyCorrectionFactor: 0,
    readings: {
      basic_charge: 1,
      energy_high: 366.15, energy_low: 0,
      // Back-solved: 240 x 28.96 = R6,950.40, matching the workbook's own Cost cell (its Reading
      // column shows 80A - see this file's header comment).
      capacity_charge: 240,
      // Back-solved: 4.4985 x 54.51 = R245.21 (workbook's own Cost cell; its Reading column shows
      // the true 4.9931kL reading, but its Cost formula used last year's 49.11 rate instead).
      water: 4.4985,
      // Back-solved: 54.51 x 0.542 = R29.54 (workbook's own Cost cell; its formula appears to have
      // used this year's water rate, 54.51, in place of the actual reading).
      water_common_area: 54.51,
      // Back-solved: 4.2782 x 22.07 = R94.42 (workbook's own Cost cell; its Cost formula used last
      // year's 18.91 sewer rate instead of this year's 22.07).
      sewer: 4.2782,
      // Back-solved: 22.07 x 0.542 = R11.96 (same "rate used as reading" quirk as water_common_area,
      // using this year's sewer rate, 22.07, instead of the actual reading).
      sewer_common_area: 22.07,
    },
  });

  console.log('55 Loper Ave - ADH Machine Tool: seeded initial tariff + July 2026 billing slip.');
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
