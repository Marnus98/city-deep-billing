// rs-farm-eagles-valley-poultry-hostels/import_history.js - seeds RS-Farm - Eagles Valley Poultry
// - Hostels's database. Same as rs-farm-malan-seuns/import_history.js: seeds NO billing slips at
// all - the client asked for this site added blank (tariff structure + rates only), so they can
// add their own monthly readings through the app's own Add Billing Slip form. Added 2026-09-29
// from the client's own "RS-Farm Monthly Slip - August 2026 - Eagles Valley Poultry - Hostels.xlsx"
// workbook (site name spelled "Eagles Vallye" in the workbook itself - a typo, not used here),
// used only to source the tariff shape/rates, not to import a slip.
//
// Same City of Tshwane "Tariff B (<=150A)" tariff as Malan Seuns (identical rates confirmed on
// both sites' own Tariffs sheets), but only 1 physical meter here rather than 3 - see
// EAGLES_VALLEY_POULTRY_COT_TARIFF_B's own header comment in flat_site_tariff_shapes.js.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff are both
// idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EAGLES_VALLEY_POULTRY_COT_TARIFF_B } = require('../flat_site_tariff_shapes');
const { seedTariff } = require('../flat_site_seed_helpers');

// No correction-factor system applies here (factorType is null on both line items) - kept at 1
// purely so seedTariff has something to store in site_tariffs' NOT NULL factor columns.
const FACTORS = { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };

const TARIFF_NAME = 'COT_Tariff_B_Eagles-Valley-Poultry-Hostels';

// From the client's own "Tariffs" tab, 2026/2027 column (the rate their August 2026 slip actually
// uses) - identical to Malan Seuns' own rates for the same tariff.
const RATES = { basic_charge: 1200, energy: 4.058 };

function main(dbFile = 'rs-farm-eagles-valley-poultry-hostels.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for RS-Farm - Eagles Valley Poultry - Hostels.');
  // effective_from matches the workbook's own reading-period start (2026-08-03) so a future rate
  // change gets its own tariff version, same pattern as every other site - no slip is seeded
  // against this tariff, it just makes the correct rates available the moment the client adds
  // their first billing slip through the app.
  const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom: '2026-08-01', shape: EAGLES_VALLEY_POULTRY_COT_TARIFF_B, rates: RATES, factors: FACTORS });
  if (tariffId) console.log('RS-Farm - Eagles Valley Poultry - Hostels: tariff structure ready (no slips seeded - blank per client request 2026-09-29).');
  return db;
}

module.exports = { run: main };
