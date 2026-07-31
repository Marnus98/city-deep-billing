// db.js - persistent SQLite storage using Node's built-in node:sqlite module.
// No external dependencies. Node >= 22.5 required (node:sqlite is stable enough for this prototype;
// see README for the production-recommended swap to PostgreSQL).
//
// Multi-property note: this platform now manages more than one physical property (see
// properties.js), and each one gets its own completely separate database FILE via open(fileName) -
// there is no shared "property_id" column anywhere to forget in a WHERE clause. The one exception
// is the small `auth.db` (opened the same way, by server.js) which holds only the shared `users`
// table so one login works across every property - see server.js's getPropertyDb()/authDb.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'billing.db'); // legacy default, kept for any script still calling open() with no args

function open(fileName = 'billing.db') {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, fileName));
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','billing','reviewer','readonly')),
    full_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id),
    name TEXT NOT NULL,
    trading_name TEXT,
    unit TEXT,
    account_number TEXT,
    email TEXT,
    phone TEXT,
    vat_number TEXT,
    billing_address TEXT,
    opening_balance REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial TEXT UNIQUE NOT NULL,
    utility_type TEXT NOT NULL CHECK(utility_type IN ('electricity','water')),
    role TEXT NOT NULL DEFAULT 'tenant' CHECK(role IN ('tenant','bulk','pv','council_check','common_area')),
    location TEXT,
    make TEXT,
    reading_type TEXT,
    ct_ratio TEXT,
    unit_scale REAL DEFAULT 1,
    notes TEXT
  );

  -- Links a meter to a tenant for a period of time, carrying the billing configuration
  -- that used to be buried in one-off Excel formula constants (allocation %, tariff code,
  -- sign, service-charge flag). Versioned by effective_from/effective_to so history is preserved.
  CREATE TABLE IF NOT EXISTS meter_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    tariff_code INTEGER, -- 1 = flat/demand, 2 = stepped (electricity only)
    service_charge_flag INTEGER NOT NULL DEFAULT 1,
    sign INTEGER NOT NULL DEFAULT 1, -- -1 for solar export / credit meters
    allocation_pct REAL NOT NULL DEFAULT 1, -- fraction of this meter's consumption billed to this tenant
    carries_network_levy INTEGER NOT NULL DEFAULT 0,
    is_common_area INTEGER NOT NULL DEFAULT 0,
    energy_only INTEGER NOT NULL DEFAULT 0, -- manual-adjustment rows where fixed charges/surcharges were hand-zeroed in the source (see calc.js)
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS tariffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utility_type TEXT NOT NULL CHECK(utility_type IN ('electricity','water')),
    code INTEGER, -- 1 or 2 for electricity, null for water
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tariff_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tariff_id INTEGER NOT NULL REFERENCES tariffs(id),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    params_json TEXT NOT NULL, -- rate components / step blocks, see calc.js for shape
    vat_rate REAL NOT NULL DEFAULT 0.15
  );

  CREATE TABLE IF NOT EXISTS billing_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL, -- e.g. '2026-03'
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    invoice_date TEXT,
    due_date TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meter_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_id INTEGER NOT NULL REFERENCES meters(id),
    billing_period_id INTEGER NOT NULL REFERENCES billing_periods(id),
    start_reading REAL NOT NULL,
    end_reading REAL NOT NULL,
    start_reading_kvarh REAL,
    end_reading_kvarh REAL,
    kva_reading REAL,
    source TEXT NOT NULL DEFAULT 'excel_import' CHECK(source IN ('excel_import','manual','automated','estimate','correction')),
    overridden INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    photo_path TEXT, -- web path to a photo of the meter dial taken when this reading was captured
                      -- (manual entries only - see server.js POST /readings/:periodId)
    entered_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(meter_id, billing_period_id)
  );

  CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    billing_period_id INTEGER NOT NULL REFERENCES billing_periods(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reviewed','finalised','issued','cancelled')),
    subtotal_excl_vat REAL NOT NULL DEFAULT 0,
    vat_rate REAL NOT NULL DEFAULT 0.15,
    vat_amount REAL NOT NULL DEFAULT 0,
    total_incl_vat REAL NOT NULL DEFAULT 0,
    electricity_consumption_kwh REAL DEFAULT 0,
    water_consumption_m3 REAL DEFAULT 0,
    invoice_number TEXT,
    generated_at TEXT DEFAULT (datetime('now')),
    finalised_at TEXT,
    finalised_by INTEGER REFERENCES users(id),
    pdf_path TEXT,
    UNIQUE(tenant_id, billing_period_id)
  );

  CREATE TABLE IF NOT EXISTS bill_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL REFERENCES bills(id),
    meter_id INTEGER REFERENCES meters(id),
    utility_type TEXT NOT NULL,
    category TEXT NOT NULL, -- service_charge, capacity_charge, energy_charge, demand_kva, demand_kvarh,
                             -- network_surcharge, business_surcharge, network_levy, water_charge,
                             -- water_surcharge, sanitation, sanitation_surcharge, water_levy
    description TEXT,
    quantity REAL,
    rate REAL,
    amount REAL NOT NULL
  );

  -- Ground truth pulled straight from the source workbook, kept only for reconciliation display.
  CREATE TABLE IF NOT EXISTS excel_reference (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    billing_period_id INTEGER NOT NULL REFERENCES billing_periods(id),
    utility_type TEXT NOT NULL,
    consumption REAL,
    charge_total_excl_vat REAL,
    UNIQUE(tenant_id, billing_period_id, utility_type)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );
  -- One row per City of Johannesburg municipal (bulk supply) account. The park has 4 physical
  -- stands each billed directly by COJ, independent of the tenant-level billing this app
  -- otherwise does - these are the "landlord" bulk accounts the site's own tenant charges are
  -- ultimately funded from, not tenant bills themselves.
  CREATE TABLE IF NOT EXISTS municipal_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    address TEXT,
    market_value REAL
  );

  -- One row per COJ statement (invoice_number is COJ's own unique ID and the true de-dup key -
  -- COJ's "Statement for" month label is informational only; see seed_municipal.js for why it
  -- can't be used as a period key). Deliberately flat (not a generic line-items table) since COJ's
  -- statement always has exactly these 6 charge categories - Property Rates, Electricity, Water,
  -- Sanitation, Refuse, Sundry - every month, for every account.
  CREATE TABLE IF NOT EXISTS municipal_statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    municipal_account_id INTEGER NOT NULL REFERENCES municipal_accounts(id),
    invoice_number TEXT UNIQUE NOT NULL,
    statement_for TEXT NOT NULL,
    statement_date TEXT,
    due_date TEXT,
    elec_reading_start TEXT, elec_reading_end TEXT,
    elec_consumption_kwh REAL, elec_consumption_kvarh REAL, elec_tariff_type TEXT,
    elec_excl_vat REAL, elec_vat REAL, elec_incl_vat REAL,
    -- Granular electricity breakdown (TOU accounts use off_peak/peak/standard; flat-rate accounts
    -- use energy instead; demand/reactive/service/network_surcharge apply to both). All are
    -- excl. VAT Rand amounts except the _kwh/_kva/_kvarh quantity columns.
    elec_off_peak_kwh REAL, elec_off_peak_rand REAL,
    elec_peak_kwh REAL, elec_peak_rand REAL,
    elec_standard_kwh REAL, elec_standard_rand REAL,
    elec_energy_kwh REAL, elec_energy_rand REAL,
    elec_demand_kva REAL, elec_demand_rand REAL,
    elec_reactive_kvarh REAL, elec_reactive_rand REAL,
    elec_service_rand REAL, elec_network_surcharge_rand REAL,
    water_reading_start TEXT, water_reading_end TEXT,
    water_consumption_kl REAL,
    water_excl_vat REAL, water_vat REAL, water_incl_vat REAL,
    sanitation_excl_vat REAL, sanitation_vat REAL, sanitation_incl_vat REAL,
    refuse_excl_vat REAL, refuse_vat REAL, refuse_incl_vat REAL,
    sundry_excl_vat REAL, sundry_vat REAL, sundry_incl_vat REAL,
    property_rates_excl_vat REAL, property_rates_vat REAL, property_rates_incl_vat REAL,
    grand_total_incl_vat REAL,
    source_file TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  `);

  // Additive migrations for columns added after the initial schema. node:sqlite's SQLite build
  // doesn't need "IF NOT EXISTS" guards for ADD COLUMN (older SQLite lacks that syntax anyway),
  // so we check PRAGMA table_info ourselves before altering, which makes this safe to re-run on
  // every boot including against the March/April data already seeded.
  const cols = db.prepare("PRAGMA table_info(meter_assignments)").all().map((c) => c.name);
  if (!cols.includes('allocation_pct_kvarh')) db.exec('ALTER TABLE meter_assignments ADD COLUMN allocation_pct_kvarh REAL');
  if (!cols.includes('allocation_pct_kva')) db.exec('ALTER TABLE meter_assignments ADD COLUMN allocation_pct_kva REAL');
  if (!cols.includes('capacity_charge_override')) db.exec('ALTER TABLE meter_assignments ADD COLUMN capacity_charge_override REAL');

  const mrCols = db.prepare("PRAGMA table_info(meter_readings)").all().map((c) => c.name);
  if (!mrCols.includes('photo_path')) db.exec('ALTER TABLE meter_readings ADD COLUMN photo_path TEXT');

  const msCols = db.prepare("PRAGMA table_info(municipal_statements)").all().map((c) => c.name);
  const newMsCols = [
    'elec_off_peak_kwh', 'elec_off_peak_rand', 'elec_peak_kwh', 'elec_peak_rand',
    'elec_standard_kwh', 'elec_standard_rand', 'elec_energy_kwh', 'elec_energy_rand',
    'elec_demand_kva', 'elec_demand_rand', 'elec_reactive_kvarh', 'elec_reactive_rand',
    'elec_service_rand', 'elec_network_surcharge_rand',
  ];
  for (const c of newMsCols) {
    if (!msCols.includes(c)) db.exec(`ALTER TABLE municipal_statements ADD COLUMN ${c} REAL`);
  }
}

module.exports = { open, migrate, DB_PATH };
