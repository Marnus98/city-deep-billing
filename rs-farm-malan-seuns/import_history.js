// rs-farm-malan-seuns/import_history.js - seeds RS-Farm - Malan Seuns's database. Unlike every
// other flat_site property's import_history.js, this one seeds NO billing slips at all - the
// client explicitly asked for this site to be added blank (tariff structure + rates only), so they
// can add their own monthly readings through the app's own Add Billing Slip form. Added 2026-09-29
// from the client's own "RS-Farm Monthly Slip - August 2026 - Malan Seuns.xlsx" workbook, used here
// only to source the tariff shape/rates, not to import a slip.
//
// This site's tariff (City of Tshwane "Tariff B (<=150A)") is a genuinely different, much simpler
// structure than the other 4 RS-Farm sites' TSHWANE_LV_TOU (no time-of-use split at all), but it's
// billed across 3 separate physical meters rather than one shared set of line items - see
// MALAN_SEUNS_COT_TARIFF_B's own header comment in flat_site_tariff_shapes.js for the full
// reasoning and the meter serial numbers each line item's label refers to.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff are both
// idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { MALAN_SEUNS_COT_TARIFF_B } = require('../flat_site_tariff_shapes');
const { seedTariff } = require('../flat_site_seed_helpers');

// No correction-factor system applies here (every line item's factorType is null, same as the
// other 4 RS-Farm sites) - kept at 1 purely so seedTariff has something to store in site_tariffs'
// NOT NULL factor columns.
const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'COT_Tariff_B_Malan-Seuns';

// From the client's own "Tariffs" tab, 2026/2027 column (the rate their August 2026 slip actually
// uses) - the same Basic Charge/Energy rate applies identically to all 3 meters, hence one `rates`
// object reused for all 6 shape keys below.
const RATES = {
  basic_charge_m1: 1200, energy_m1: 4.058,
  basic_charge_m2: 1200, energy_m2: 4.058,
  basic_charge_m3: 1200, energy_m3: 4.058,
};

function main(dbFile = 'rs-farm-malan-seuns.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for RS-Farm - Malan Seuns.');
  // effective_from matches the workbook's own reading-period start (2026-08-03) so a future
  // rate change gets its own tariff version the same way every other site does it - no slip is
  // seeded against this tariff, it just makes the correct rates available the moment the client
  // adds their first billing slip through the app.
  const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom: '2026-08-01', shape: MALAN_SEUNS_COT_TARIFF_B, rates: RATES, factors: FACTORS });
  if (tariffId) console.log('RS-Farm - Malan Seuns: tariff structure ready (no slips seeded - blank per client request 2026-09-29).');
  return db;
}

module.exports = { run: main };
