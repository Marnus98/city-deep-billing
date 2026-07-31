// seed_municipal.js - imports municipal_statements.json (produced by extracting the City of
// Johannesburg PDF statements you upload) into the municipal_accounts/municipal_statements
// tables. This is a separate, self-contained pipeline from seed.js/billing.js - it doesn't touch
// tenants, meters, or bills at all.
//
// How to add a new month: attach the new COJ statement PDF in chat, it gets parsed and appended
// to municipal_statements.json (invoice_number is the de-dup key, so re-running this is always
// safe), then re-run `node seed_municipal.js` (or just redeploy - server.js auto-runs this on
// boot alongside the main seed, same pattern as the rest of this app).
//
// Important: COJ's own "Statement for" label is NOT a reliable period key - the same physical
// statement is sometimes labelled one calendar month ahead of the reading period it actually
// covers (confirmed: a statement you named "... - Feb 26.pdf" prints "Statement for March 2026"
// inside it, because the reading period underneath runs 2026/02/14 to 2026/03/27 - mostly
// February). Electricity and water even have their *own*, different reading periods within the
// same statement. Store both the raw "Statement for" label and the actual reading period dates,
// and always match periods by reading-period-date-overlap, never by label string.
const fs = require('fs');
const path = require('path');
const { open, migrate } = require('../db');

// City Deep-specific pipeline (COJ municipal accounts belong to City Deep's own property db) -
// `db` is opened lazily inside main(dbFile), same pattern as seed.js, so requiring this module
// doesn't implicitly touch any database until run(dbFile) is actually called.
let db;

function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }

const ACCOUNTS = [
  { account_number: '559304078', label: 'Mini' },
  { account_number: '559304085', label: 'Rittle' },
  { account_number: '559304053', label: 'Industrial A' },
  { account_number: '559304060', label: 'Industrial B' },
];

function getOrCreateAccount(accNumber, address, marketValue) {
  let acc = get('SELECT * FROM municipal_accounts WHERE account_number=?', [accNumber]);
  const known = ACCOUNTS.find((a) => a.account_number === accNumber);
  const label = known ? known.label : accNumber;
  if (!acc) {
    run('INSERT INTO municipal_accounts (account_number, label, address, market_value) VALUES (?,?,?,?)',
      [accNumber, label, address || null, marketValue || null]);
    acc = get('SELECT * FROM municipal_accounts WHERE account_number=?', [accNumber]);
  } else if (address && acc.address !== address) {
    run('UPDATE municipal_accounts SET address=?, market_value=? WHERE id=?', [address, marketValue || acc.market_value, acc.id]);
  }
  return acc;
}

function round2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

function seedStatement(rec) {
  const acc = getOrCreateAccount(rec.account, rec.address, rec.market_value);
  const existing = get('SELECT id FROM municipal_statements WHERE invoice_number=?', [rec.invoice_number]);

  const w = rec.water;
  const waterExcl = w.water_excl_vat || 0;
  const sanExcl = w.sanitation_excl_vat || 0;
  const waterSanExcl = waterExcl + sanExcl;
  // The source statement has one combined VAT line for Water & Sanitation together - split it
  // proportionally between the two so each has its own incl-VAT figure. Both are 15%, so this is
  // exact to the cent except for whichever category picks up the rounding remainder.
  const waterVat = waterSanExcl > 0 ? round2((w.vat || 0) * (waterExcl / waterSanExcl)) : 0;
  const sanVat = round2((w.vat || 0) - waterVat);

  const L = rec.electricity.lines || {};

  // Same field list, values, whether this is an INSERT (new invoice_number) or UPDATE (re-running
  // the seed against an invoice already imported - e.g. after a schema/extractor change). UPDATE
  // rather than delete-then-reinsert specifically to keep each statement's row id stable across
  // re-seeds: the id is used directly in /municipal-pdf download links, and those links are only
  // useful if they keep working after the next redeploy.
  const fields = [
    'municipal_account_id', 'invoice_number', 'statement_for', 'statement_date', 'due_date',
    'elec_reading_start', 'elec_reading_end', 'elec_consumption_kwh', 'elec_consumption_kvarh', 'elec_tariff_type',
    'elec_excl_vat', 'elec_vat', 'elec_incl_vat',
    'elec_off_peak_kwh', 'elec_off_peak_rand', 'elec_peak_kwh', 'elec_peak_rand',
    'elec_standard_kwh', 'elec_standard_rand', 'elec_energy_kwh', 'elec_energy_rand',
    'elec_demand_kva', 'elec_demand_rand', 'elec_reactive_kvarh', 'elec_reactive_rand',
    'elec_service_rand', 'elec_network_surcharge_rand',
    'water_reading_start', 'water_reading_end', 'water_consumption_kl',
    'water_excl_vat', 'water_vat', 'water_incl_vat',
    'sanitation_excl_vat', 'sanitation_vat', 'sanitation_incl_vat',
    'refuse_excl_vat', 'refuse_vat', 'refuse_incl_vat',
    'sundry_excl_vat', 'sundry_vat', 'sundry_incl_vat',
    'property_rates_excl_vat', 'property_rates_vat', 'property_rates_incl_vat',
    'grand_total_incl_vat', 'source_file',
  ];
  const values = [
    acc.id, rec.invoice_number, rec.statement_for, rec.statement_date, rec.due_date,
    rec.electricity.reading_period ? rec.electricity.reading_period[0] : null,
    rec.electricity.reading_period ? rec.electricity.reading_period[1] : null,
    rec.electricity.consumption_kwh, rec.electricity.consumption_kvarh, rec.electricity.tariff_type,
    rec.electricity.excl_vat, rec.electricity.vat, rec.electricity.incl_vat,
    L.off_peak_qty || 0, L.off_peak || 0, L.peak_qty || 0, L.peak || 0,
    L.standard_qty || 0, L.standard || 0, L.energy_qty || 0, L.energy || 0,
    L.demand_qty || 0, L.demand || 0, L.reactive_qty || 0, L.reactive || 0,
    L.service || 0, L.network_surcharge || 0,
    w.reading_period ? w.reading_period[0] : null, w.reading_period ? w.reading_period[1] : null, w.consumption_kl,
    round2(waterExcl), waterVat, round2(waterExcl + waterVat),
    round2(sanExcl), sanVat, round2(sanExcl + sanVat),
    rec.refuse.excl_vat, rec.refuse.vat, rec.refuse.incl_vat,
    rec.sundry.excl_vat, rec.sundry.vat, rec.sundry.incl_vat,
    rec.property_rates.excl_vat, rec.property_rates.vat, rec.property_rates.incl_vat,
    rec.grand_total_incl_vat, rec.file,
  ];

  if (existing) {
    run(`UPDATE municipal_statements SET ${fields.map((f) => `${f}=?`).join(', ')} WHERE id=?`, [...values, existing.id]);
  } else {
    run(`INSERT INTO municipal_statements (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(',')})`, values);
  }
  return existing ? 'updated' : 'created';
}

function main(dbFile = 'city-deep.db') {
  db = open(dbFile);
  migrate(db);
  const jsonPath = path.join(__dirname, 'imports', 'municipal_statements.json');
  if (!fs.existsSync(jsonPath)) { console.log('No municipal_statements.json found - skipping municipal import.'); return; }
  const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  let created = 0, updated = 0;
  db.exec('BEGIN');
  try {
    for (const rec of records) {
      if (seedStatement(rec) === 'created') created++; else updated++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`Municipal import: ${created} statement(s) added, ${updated} refreshed.`);
}

if (require.main === module) { main(); db.close(); }
module.exports = { run: main };
