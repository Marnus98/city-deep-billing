// field-street/seed.js - seeds 8 Field Street's database with its first tariff version and its
// first billing slip (July 2026), taken directly from the reference statement the client
// provided ("8 Field Street Main Electrical", Ekurhuleni_Tariff_E_TOU_8 Field Street). Unlike
// city-deep/seed.js or wingfield/seed_wingfield.js, there's no workbook to bulk-import here - this
// property is billed going forward via the fillable "Add billing slip" form (server.js's
// /site-billing routes), so this script only plants that first known-good month as a working
// example. Safe to re-run: both inserts are idempotent (site_tariffs is looked up by
// effective_from, site_billing_slips by its UNIQUE label).
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');

let db;
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }

function seedTariff() {
  const effectiveFrom = '2026-07-01';
  let t = get('SELECT * FROM site_tariffs WHERE effective_from=?', [effectiveFrom]);
  if (t) return t;
  run(`INSERT INTO site_tariffs (
      effective_from, fixed_charge_rate, network_access_rate, network_demand_rate,
      peak_high_rate, peak_low_rate, standard_high_rate, standard_low_rate,
      offpeak_high_rate, offpeak_low_rate, water_rate, sewer_rate,
      kva_factor, peak_factor, standard_factor, offpeak_factor, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      effectiveFrom, 5676.25, 112.25, 159.25,
      11.44, 3.72, 3.31, 2.43,
      2.03, 1.85, 54.51, 22.07,
      1.038681688, 1.017448464, 1.017563209, 1.017174764,
      'Initial tariff, taken from the client-provided "8 Field Street Main Electrical" statement '
      + '(Ekurhuleni_Tariff_E_TOU_8 Field Street) for the period 2026-07-01 to 2026-08-01. Factors '
      + 'are the site-meter-vs-municipal-meter correction the client confirmed (our meters read low).',
    ]);
  return get('SELECT * FROM site_tariffs WHERE effective_from=?', [effectiveFrom]);
}

function seedSlip(tariff) {
  const label = '2026-07';
  const existing = get('SELECT id FROM site_billing_slips WHERE label=?', [label]);
  if (existing) return;
  run(`INSERT INTO site_billing_slips (
      label, start_date, end_date, tariff_id,
      network_access_kva, network_access_comment,
      network_demand_kva, network_demand_comment,
      peak_high_kwh, peak_low_kwh, standard_high_kwh, standard_low_kwh,
      offpeak_high_kwh, offpeak_low_kwh, water_kl, sewer_kl, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      label, '2026-07-01', '2026-08-01', tariff.id,
      628.49, '2026/07/15 22:00',
      628.49, '2026/07/15 22:00',
      54891.82, 0, 117534.54, 0,
      140252.84, 0, 197.61, 197.61, 'finalised',
    ]);
}

function main(dbFile = 'field-street.db') {
  db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users: admin/admin123, billing/billing123, reviewer/reviewer123, viewer/viewer123');
  const tariff = seedTariff();
  seedSlip(tariff);
  console.log('8 Field Street: seeded initial tariff + July 2026 billing slip.');
  return db;
}

if (require.main === module) { main(); db.close(); }
module.exports = { run: main };
