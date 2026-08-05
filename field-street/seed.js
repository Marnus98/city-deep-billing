// field-street/seed.js - seeds 8 Field Street's database with its first tariff version and its
// first billing slip (July 2026), taken directly from the reference statement the client
// provided ("8 Field Street Main Electrical", Ekurhuleni_Tariff_E_TOU_8 Field Street). Historical
// months before July 2026 come from import_history.js instead - this script only plants that first
// known-good month as a working example. Safe to re-run: both inserts are idempotent (see
// flat_site_seed_helpers.js).
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_E_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

function main(dbFile = 'field-street.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');

  const tariffId = seedTariff(db, {
    tariffName: 'Ekurhuleni_Tariff_E_TOU_8 Field Street',
    effectiveFrom: '2026-07-01',
    shape: EKURHULENI_E_TOU,
    rates: {
      fixed_charge: 5676.25, network_access: 112.25, network_demand: 159.25,
      peak_high: 11.44, peak_low: 3.72, standard_high: 3.31, standard_low: 2.43,
      offpeak_high: 2.03, offpeak_low: 1.85, water: 54.51, sewer: 22.07,
    },
    factors: FACTORS,
    notes: 'Initial tariff, taken from the client-provided "8 Field Street Main Electrical" statement '
      + '(Ekurhuleni_Tariff_E_TOU_8 Field Street) for the period 2026-07-01 to 2026-08-01. Factors '
      + 'are the site-meter-vs-municipal-meter correction the client confirmed (our meters read low).',
  });

  seedSlip(db, tariffId, {
    label: '2026-07', startDate: '2026-07-01', endDate: '2026-08-01',
    readings: {
      network_access: { reading: 628.49, comment: '2026/07/15 22:00' },
      network_demand: { reading: 628.49, comment: '2026/07/15 22:00' },
      peak_high: 54891.82, peak_low: 0, standard_high: 117534.54, standard_low: 0,
      offpeak_high: 140252.84, offpeak_low: 0, water: 197.61, sewer: 197.61,
    },
  });

  console.log('8 Field Street: seeded initial tariff + July 2026 billing slip.');
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
