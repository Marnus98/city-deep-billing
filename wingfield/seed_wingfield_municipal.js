// seed_wingfield_municipal.js - imports wingfield_municipal_statements.json (produced by
// extract_wingfield_municipal.py against the 13 City of Ekurhuleni PDF invoices you uploaded)
// into Wingfield's own municipal_accounts/municipal_statements tables. Mirrors seed_municipal.js's
// structure and insertion pattern exactly - same schema, same "invoice_number is the de-dup key so
// re-running is always safe" approach - but is its own file because Ekurhuleni's statement layout
// (single combined account, a flat property-rates line, no separate account-per-precinct) is
// different enough from City of Johannesburg's that sharing one parser would mean threading two
// municipalities' quirks through one function.
//
// Electricity IS Time-of-Use here (Peak/Standard/Off-peak, not flat) - corrected after the client
// caught that an earlier pass of this pipeline had wrongly lumped all 3 registers into one "flat
// energy" total. See extract_wingfield_municipal.py for how each kWh line is classified by its own
// rate (unambiguous - Peak/Standard/Off-peak rates never overlap across any of the 13 months),
// verified against a reference table the client independently rebuilt from these same invoices.
//
// Ekurhuleni quirk worth knowing: three of the thirteen statements (Nov 2025, Dec 2025, Jan 2026)
// carry one-off "INTERIM"/"INTERIM REVERSAL" water & sewer adjustment lines instead of the usual
// "WATER n kl"/"SEWER-BUSINESS n kl" lines (an estimated-reading correction, not a mistake), and
// Oct 2025 carries a one-off "FINAL NOTICE" fee. extract_wingfield_municipal.py handles both by
// summing whatever charge-shaped rows fall within each utility's section of the statement rather
// than only matching specific labels - every one of the 13 months reconciles to the cent against
// that statement's own "TOTAL CURRENT LEVY" figure (the current month's own new charges, separate
// from any arrears/balance-brought-forward also shown on the same statement - see README).
const fs = require('fs');
const path = require('path');
const { open, migrate } = require('../db');

let db;

function run(sql, params = []) { return db.prepare(sql).run(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }

const ACCOUNTS = [
  { account_number: '2210755502', label: 'Refinery' },
];

function getOrCreateAccount(accNumber, address, marketValue) {
  let acc = get('SELECT * FROM municipal_accounts WHERE account_number=?', [accNumber]);
  const known = ACCOUNTS.find((a) => a.account_number === accNumber);
  const label = known ? known.label : accNumber;
  if (!acc) {
    run('INSERT INTO municipal_accounts (account_number, label, address, market_value) VALUES (?,?,?,?)',
      [accNumber, label, address || null, marketValue || null]);
    acc = get('SELECT * FROM municipal_accounts WHERE account_number=?', [accNumber]);
  } else if (marketValue && acc.market_value !== marketValue) {
    // Address is constant across all 12 months but the property valuation was revised partway
    // through (183,000,000 -> 192,150,000 from Dec 2025 onward) - keep the account row current
    // with whichever statement was imported most recently, same as an address change would.
    run('UPDATE municipal_accounts SET address=?, market_value=? WHERE id=?', [address || acc.address, marketValue, acc.id]);
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
  const waterVat = waterSanExcl > 0 ? round2((w.vat || 0) * (waterExcl / waterSanExcl)) : 0;
  const sanVat = round2((w.vat || 0) - waterVat);

  const L = rec.electricity.lines || {};

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
    L.standard_qty || 0, L.standard || 0, 0, 0,
    L.demand_qty || 0, L.demand || 0, 0, 0,
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

function main(dbFile = 'wingfield.db') {
  db = open(dbFile);
  migrate(db);
  const jsonPath = path.join(__dirname, 'imports', 'wingfield_municipal_statements.json');
  if (!fs.existsSync(jsonPath)) { console.log('No wingfield_municipal_statements.json found - skipping Wingfield municipal import.'); return; }
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
  console.log(`Wingfield municipal import: ${created} statement(s) added, ${updated} refreshed.`);
}

if (require.main === module) { main(); db.close(); }
module.exports = { run: main };
