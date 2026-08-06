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

  -- "Flat single-site" billing (first user: 8 Field Street, see field-street/). Unlike City Deep/
  -- Wingfield's tenant-per-meter model, a flat_site property (see properties.js's billingModel)
  -- has exactly one set of fixed line items every month - Fixed Charge, Network Access, Network
  -- Demand, Peak/Standard/Off-Peak Energy (each split High/Low demand season), Water, Sewer - so
  -- a small fixed schema fits better than reusing tenants/meters/bills. Both tables are created in
  -- every property's database (same pattern as municipal_statements) but only populated for
  -- properties that actually use this billing model; harmless and empty otherwise.
  --
  -- site_tariffs: one row per rate change. Kept as its own versioned table (rather than just
  -- columns on site_billing_slips) so a slip can be re-priced if a rate turns out wrong without
  -- retyping every reading, and so the "reflects the tariff for that month" requirement has a real
  -- history instead of only ever showing the latest rate. kva/peak/standard/offpeak_factor exist
  -- because the site's own installed meters read measurably lower than the municipality's check
  -- meter - readings are entered as read off our own meter dial, and these factors gross them up
  -- to real consumption before the tariff rate is applied (see calc_field_street.js). Defaults are
  -- the values confirmed for 8 Field Street; editable per version in case they're ever recalibrated.
  CREATE TABLE IF NOT EXISTS site_tariffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tariff_name TEXT, -- short display label, e.g. "Ekurhuleni_Tariff_E_TOU_8 Field Street" - shown
      -- on the slip/PDF header. Was hardcoded per-property before a second tariff shape existed;
      -- now every flat_site property can show its own tariff's real name.
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    fixed_charge_rate REAL NOT NULL DEFAULT 0,
    network_access_rate REAL NOT NULL DEFAULT 0,
    network_demand_rate REAL NOT NULL DEFAULT 0,
    peak_high_rate REAL NOT NULL DEFAULT 0, peak_low_rate REAL NOT NULL DEFAULT 0,
    standard_high_rate REAL NOT NULL DEFAULT 0, standard_low_rate REAL NOT NULL DEFAULT 0,
    offpeak_high_rate REAL NOT NULL DEFAULT 0, offpeak_low_rate REAL NOT NULL DEFAULT 0,
    water_rate REAL NOT NULL DEFAULT 0,
    sewer_rate REAL NOT NULL DEFAULT 0,
    kva_factor REAL NOT NULL DEFAULT 1,
    peak_factor REAL NOT NULL DEFAULT 1,
    standard_factor REAL NOT NULL DEFAULT 1,
    offpeak_factor REAL NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- site_billing_slips: one row per billing period. Readings are stored exactly as read off the
  -- site's own meter (pre-factor) - the factor lives on the tariff row so cost can always be
  -- recomputed the same way the slip originally was. network_access_comment/network_demand_comment
  -- hold the municipality's max-demand timestamp note (see the reference statement's "Comment"
  -- column - only those two rows ever carry one).
  CREATE TABLE IF NOT EXISTS site_billing_slips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL, -- e.g. '2026-07'
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    tariff_id INTEGER NOT NULL REFERENCES site_tariffs(id),
    network_access_kva REAL DEFAULT 0, network_access_comment TEXT,
    network_demand_kva REAL DEFAULT 0, network_demand_comment TEXT,
    peak_high_kwh REAL DEFAULT 0, peak_low_kwh REAL DEFAULT 0,
    standard_high_kwh REAL DEFAULT 0, standard_low_kwh REAL DEFAULT 0,
    offpeak_high_kwh REAL DEFAULT 0, offpeak_low_kwh REAL DEFAULT 0,
    water_kl REAL DEFAULT 0,
    sewer_kl REAL DEFAULT 0,
    apply_correction_factor INTEGER NOT NULL DEFAULT 1, -- advanced/rarely-touched: whether this
      -- month's readings get grossed up by the tariff's kva/peak/standard/offpeak_factor at all.
      -- Stays on (1) for normal months read off the site's own meter; turn off only for a month
      -- where the site meter was recalibrated to match the municipal meter (or for historical
      -- months where the "reading" entered is already the municipal statement's own figure).
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finalised')),
    entered_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
  -- NOTE: site_tariffs' fixed_charge_rate...sewer_rate columns above and site_billing_slips'
  -- network_access_kva...sewer_kl columns above are legacy - they were the whole schema when 8
  -- Field Street was the only flat_site property (one hardcoded shape: Fixed Charge/Network
  -- Access/Network Demand/Peak/Standard/Off-Peak x High/Low/Water/Sewer). Once a second site
  -- turned up on a *different* tariff shape (different line items entirely - see
  -- flat_site_tariff_shapes.js), those fixed columns stopped being able to describe every site, so
  -- rates/readings moved to the two generic tables below instead. The old columns are kept
  -- (harmless, DEFAULT 0/NULL, never written by new code) rather than dropped, both because
  -- node:sqlite's SQLite build makes DROP COLUMN riskier than it's worth here, and so migrate()
  -- below can still read them once, to carry forward whatever the client already typed into an
  -- already-deployed 8 Field Street instance before this migration ships.

  -- site_tariff_items: one row per line item *per tariff version* - this is what actually varies
  -- between tariff shapes (a City Power site has "Excess Reactive"/"Network Surcharge" rows that an
  -- Ekurhuleni site doesn't, and even two Ekurhuleni tariffs order/name their rows differently).
  -- item_key is stable across tariff versions of the *same site* (e.g. always 'peak_high') so a
  -- slip's readings (site_slip_readings, keyed by item_key) keep lining up correctly even after a
  -- rate change creates a new site_tariffs row. factor_type says which of the tariff's 4 correction
  -- factors (if any) grosses up this row's reading before the rate is applied - see
  -- calc_flat_site.js. section splits the slip's PDF/UI into two tables (electricity vs water),
  -- matching every reference statement seen so far.
  CREATE TABLE IF NOT EXISTS site_tariff_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tariff_id INTEGER NOT NULL REFERENCES site_tariffs(id),
    sort_order INTEGER NOT NULL,
    section TEXT NOT NULL DEFAULT 'electricity' CHECK(section IN ('electricity','water')),
    item_key TEXT NOT NULL,
    label TEXT NOT NULL,
    unit TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 0,
    factor_type TEXT CHECK(factor_type IN ('kva','peak','standard','offpeak') OR factor_type IS NULL),
    fixed_reading REAL, -- non-NULL for a flat per-slip charge (e.g. 1) that's never typed in
    has_comment INTEGER NOT NULL DEFAULT 0
  );

  -- site_slip_readings: one row per line item *per slip* - the actual meter reading (or fixed-row
  -- placeholder) a slip carries for one of its tariff's item_keys, as read off the site's own
  -- meter (pre-factor). One UNIQUE(slip_id, item_key) row per line item; a slip's full reading set
  -- is however many rows its tariff's site_tariff_items defines.
  CREATE TABLE IF NOT EXISTS site_slip_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_id INTEGER NOT NULL REFERENCES site_billing_slips(id),
    item_key TEXT NOT NULL,
    reading REAL NOT NULL DEFAULT 0,
    comment TEXT,
    UNIQUE(slip_id, item_key)
  );

  -- municipal_tariffs / municipal_tariff_items / municipal_statement_slips /
  -- municipal_statement_readings: the actual municipality (e.g. Ekurhuleni) account statement for a
  -- flat_site property, as opposed to site_tariffs/site_billing_slips above (what HolmStone bills
  -- the client). Deliberately a full parallel set of tables rather than a 'kind' column on the
  -- site_* tables - the two are genuinely different documents (different line items even: Property
  -- Rates and Refuse only ever appear on the municipal statement, never on the client-facing slip)
  -- billed by different parties, and keeping them physically separate means nothing about the
  -- already-working site billing engine had to change or risk regressing to add this. The row
  -- shapes are identical on purpose so calc_flat_site.js's computeSlip() and pdf.js's
  -- drawSiteLineItemsTable() work unmodified on either - see municipal_seed_helpers.js.
  CREATE TABLE IF NOT EXISTS municipal_tariffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tariff_name TEXT,
    effective_from TEXT NOT NULL,
    kva_factor REAL NOT NULL DEFAULT 1,
    peak_factor REAL NOT NULL DEFAULT 1,
    standard_factor REAL NOT NULL DEFAULT 1,
    offpeak_factor REAL NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- section adds 'municipal' (Property Rates, Refuse - charges that are neither electricity nor
  -- water) alongside the two sections site_tariff_items supports - see calc_flat_site.js's
  -- computeSlip() for how the third bucket is folded into the total. vat_exempt exists because
  -- Property Rates specifically is VAT-exempt on the real Ekurhuleni statement (Refuse and every
  -- electricity/water line still attract the normal 15% - confirmed by back-checking each source
  -- statement's own printed VAT figure) - see calc_flat_site.js for how this is excluded from the
  -- VATable base without excluding it from the line-item subtotal itself.
  CREATE TABLE IF NOT EXISTS municipal_tariff_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tariff_id INTEGER NOT NULL REFERENCES municipal_tariffs(id),
    sort_order INTEGER NOT NULL,
    section TEXT NOT NULL DEFAULT 'electricity' CHECK(section IN ('electricity','water','municipal')),
    item_key TEXT NOT NULL,
    label TEXT NOT NULL,
    unit TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 0,
    factor_type TEXT CHECK(factor_type IN ('kva','peak','standard','offpeak') OR factor_type IS NULL),
    fixed_reading REAL,
    has_comment INTEGER NOT NULL DEFAULT 0,
    vat_exempt INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS municipal_statement_slips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT UNIQUE NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    tariff_id INTEGER NOT NULL REFERENCES municipal_tariffs(id),
    apply_correction_factor INTEGER NOT NULL DEFAULT 0, -- off by default: a municipal statement's
      -- readings are the municipality's own meter figures already, not the site's own under-reading
      -- meter, so there's normally nothing to gross up (unlike site_billing_slips, which defaults on).
    status TEXT NOT NULL DEFAULT 'finalised' CHECK(status IN ('draft','finalised')),
    entered_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS municipal_statement_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_id INTEGER NOT NULL REFERENCES municipal_statement_slips(id),
    item_key TEXT NOT NULL,
    reading REAL NOT NULL DEFAULT 0,
    comment TEXT,
    UNIQUE(slip_id, item_key)
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

  const sbsCols = db.prepare("PRAGMA table_info(site_billing_slips)").all().map((c) => c.name);
  if (!sbsCols.includes('apply_correction_factor')) db.exec('ALTER TABLE site_billing_slips ADD COLUMN apply_correction_factor INTEGER NOT NULL DEFAULT 1');

  const stCols = db.prepare("PRAGMA table_info(site_tariffs)").all().map((c) => c.name);
  if (!stCols.includes('tariff_name')) db.exec('ALTER TABLE site_tariffs ADD COLUMN tariff_name TEXT');

  // One-time bridge: any flat_site data written before site_tariff_items/site_slip_readings
  // existed (8 Field Street was the only flat_site property back then, always on the Ekurhuleni E
  // TOU shape) lives in site_tariffs'/site_billing_slips' legacy fixed columns. If the new tables
  // are still empty but there's legacy tariff data sitting there, expand it into the new generic
  // tables once, so an already-deployed instance doesn't lose readings the client already typed in
  // (e.g. the water/sewer figures entered by hand) just because this schema shipped. Guarded on
  // site_tariff_items being empty, so this only ever runs the single time it's needed.
  const itemsEmpty = db.prepare('SELECT COUNT(*) c FROM site_tariff_items').get().c === 0;
  if (itemsEmpty) {
    const legacyTariffs = db.prepare('SELECT * FROM site_tariffs WHERE fixed_charge_rate > 0 OR network_access_rate > 0').all();
    if (legacyTariffs.length) {
      const EK_E_ITEMS = [
        ['fixed_charge', 'Fixed Charge', 'R/c', 'fixed_charge_rate', null, 1, 0, 'electricity'],
        ['network_access', 'Network Access', 'R/kVA', 'network_access_rate', 'kva', null, 1, 'electricity'],
        ['network_demand', 'Network Demand', 'R/kVA', 'network_demand_rate', 'kva', null, 1, 'electricity'],
        ['peak_high', 'Peak Energy - High Demand', 'R/kWh', 'peak_high_rate', 'peak', null, 0, 'electricity'],
        ['peak_low', 'Peak Energy - Low Demand', 'R/kWh', 'peak_low_rate', 'peak', null, 0, 'electricity'],
        ['standard_high', 'Standard Energy - High Demand', 'R/kWh', 'standard_high_rate', 'standard', null, 0, 'electricity'],
        ['standard_low', 'Standard Energy - Low Demand', 'R/kWh', 'standard_low_rate', 'standard', null, 0, 'electricity'],
        ['offpeak_high', 'Off-Peak Energy - High Demand', 'R/kWh', 'offpeak_high_rate', 'offpeak', null, 0, 'electricity'],
        ['offpeak_low', 'Off-Peak Energy - Low Demand', 'R/kWh', 'offpeak_low_rate', 'offpeak', null, 0, 'electricity'],
        ['water', 'Water Consumption', 'R/kL', 'water_rate', null, null, 0, 'water'],
        ['sewer', 'Sewer', 'R/kL', 'sewer_rate', null, null, 0, 'water'],
      ];
      const readingColByKey = {
        network_access: ['network_access_kva', 'network_access_comment'],
        network_demand: ['network_demand_kva', 'network_demand_comment'],
        peak_high: ['peak_high_kwh', null], peak_low: ['peak_low_kwh', null],
        standard_high: ['standard_high_kwh', null], standard_low: ['standard_low_kwh', null],
        offpeak_high: ['offpeak_high_kwh', null], offpeak_low: ['offpeak_low_kwh', null],
        water: ['water_kl', null], sewer: ['sewer_kl', null],
      };
      for (const t of legacyTariffs) {
        db.prepare('UPDATE site_tariffs SET tariff_name=? WHERE id=? AND (tariff_name IS NULL OR tariff_name=\'\')')
          .run('Ekurhuleni_Tariff_E_TOU_8 Field Street', t.id);
        EK_E_ITEMS.forEach(([key, label, unit, rateCol, factorType, fixedReading, hasComment, section], i) => {
          db.prepare(`INSERT INTO site_tariff_items (tariff_id, sort_order, section, item_key, label, unit, rate, factor_type, fixed_reading, has_comment)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(t.id, i, section, key, label, unit, t[rateCol] || 0, factorType, fixedReading, hasComment);
        });
        const slips = db.prepare('SELECT * FROM site_billing_slips WHERE tariff_id=?').all(t.id);
        for (const slip of slips) {
          for (const [key, [readingCol, commentCol]] of Object.entries(readingColByKey)) {
            const reading = slip[readingCol] || 0;
            const comment = commentCol ? (slip[commentCol] || null) : null;
            db.prepare('INSERT OR IGNORE INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,?)')
              .run(slip.id, key, reading, comment);
          }
        }
      }
      console.log(`Flat-site legacy migration: expanded ${legacyTariffs.length} tariff version(s) into the new line-item schema.`);
    }
  }

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
