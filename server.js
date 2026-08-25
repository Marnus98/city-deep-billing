// server.js - plain Node http server (no framework dependency - see README for why).
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const { AsyncLocalStorage } = require('async_hooks');
const { open, migrate } = require('./db');
const auth = require('./auth');
const views = require('./views');
const { buildBillingSlipPdf, buildMunicipalStatementPdf, buildSiteBillingSlipPdf, buildRecoveryPdf, buildSiteBillingSlipsCombinedPdf, buildMunicipalStatementsCombinedPdf, buildFlaggingReportPdf } = require('./pdf');
const billing = require('./billing');
const solar = require('./solar');
const municipalCompare = require('./municipal_compare');
const properties = require('./properties');
const { seedUsers } = require('./shared_seed_users');
const calcFlatSite = require('./calc_flat_site');
const flatSiteRecovery = require('./flat_site_recovery');
const tenantRecovery = require('./tenant_recovery');
const cityDeepRecoveryGroups = require('./city-deep/recovery_groups');
const solarCost = require('./city-deep/solar_cost');
const flagging = require('./flagging');
const cityDeepFlagging = require('./city-deep/flagging_data');
const wingfieldFlagging = require('./wingfield/flagging_data');
const flatSiteFlagging = require('./flat_site_flagging_data');

const PORT = process.env.PORT || 8787;
const DEFAULT_PROPERTY_SLUG = properties[0].slug;

// ---------------- multi-property database wiring ----------------
// Every property (see properties.js) gets its own completely separate SQLite file, opened once
// here and cached in `propertyDbs`. There is deliberately no shared table with a property_id
// column anywhere - the isolation between City Deep and Wingfield (and whatever's added later)
// is physical (different files), not a WHERE clause someone could forget.
//
// The one exception is logins: `authDb` holds a single shared `users` table so one set of
// credentials works across every property (see the /login route below, and shared_seed_users.js
// for why each property db *also* gets a matching local copy of the same users, purely to satisfy
// its own audit_log.user_id foreign key).
const authDb = open('auth.db');
migrate(authDb);
if (seedUsers(authDb)) console.log('Seeded shared platform logins (auth.db).');

const propertyDbs = new Map(); // slug -> DatabaseSync
for (const prop of properties) {
  let propDb = open(prop.dbFile);
  migrate(propDb);
  // "Empty" means different things per billingModel: a tenant-billed property (City Deep,
  // Wingfield) is empty when it has no tenants; a flat_site property (8 Field Street) never has
  // tenants at all, so it's empty when it has no billing slips yet instead - checking `tenants`
  // for a flat_site property would (harmlessly, but pointlessly) re-run its seed on every single
  // boot forever, since that table is always 0 for it.
  const emptyCheckTable = prop.billingModel === 'flat_site' ? 'site_billing_slips' : 'tenants';
  const isEmpty = propDb.prepare(`SELECT COUNT(*) c FROM ${emptyCheckTable}`).get().c === 0;
  if (isEmpty) {
    propDb.close();
    let seedModule = null;
    try { seedModule = require(prop.seedFile); } catch (err) {
      console.log(`No seed script for "${prop.name}" yet (${err.code === 'MODULE_NOT_FOUND' ? prop.seedFile + ' not created' : err.message}) - starting empty.`);
    }
    if (seedModule && seedModule.run) {
      console.log(`Empty database detected for "${prop.name}" - running initial seed...`);
      propDb = seedModule.run(prop.dbFile);
      console.log(`Initial seed complete for "${prop.name}".`);
    } else {
      propDb = open(prop.dbFile);
      migrate(propDb);
    }
  }
  propertyDbs.set(prop.slug, propDb);
}
// Each property's municipal-account statements are their own separate, self-contained pipeline
// (own de-dup key: invoice_number per property db) - always safe to re-run on every boot, not just
// when empty. City Deep is billed by City of Johannesburg (seed_municipal.js); Wingfield is billed
// by City of Ekurhuleni, a different municipality with its own statement layout entirely (see
// seed_wingfield_municipal.js).
require('./city-deep/seed_municipal').run('city-deep.db');
require('./wingfield/seed_wingfield_municipal').run('wingfield.db');
// The solar plant owner's own monthly invoices to the property (Industrial Park + Mini Park only -
// see city-deep/solar_cost.js) - own de-dup key (sub_site + period_label), always safe to re-run.
require('./city-deep/solar_cost').run('city-deep.db');
// 8 Field Street's historical electricity months (Jul 2025 - Jun 2026) - own de-dup key (label),
// always safe to re-run; see field-street/import_history.js for why it never touches water/sewer.
require('./field-street/import_history').run('field-street.db');
// 8 Field Street's actual municipal account statements (Sep 2025 - Jun 2026, Apr 2026 missing - no
// statement was provided for it) - own de-dup key (label), separate tables from the above (see
// db.js), always safe to re-run; see field-street/municipal_import.js for the tariff-change/
// anomaly notes flagged during extraction.
require('./field-street/municipal_import').run('field-street.db');
// The 4 "Other Sites" flat_site properties - each script covers that site's full known history
// (own de-dup key: slip label) and also seeds that site's users on first run, so registering them
// here (in addition to being each property's seedFile above) is a safety net matching 8 Field
// Street's pattern: guards against a partially-populated db (not technically "empty") missing
// some historical months after an ephemeral-disk reset.
require('./bob-martin/import_history').run('bob-martin.db');
require('./loper-road/import_history').run('loper-road.db');
require('./autozone/import_history').run('autozone.db');
require('./cranbrook-flavours/import_history').run('cranbrook-flavours.db');
// Bob Martin's actual municipal account statements (Dec 2025, Jan/Feb/Mar/May 2026 - Apr 2026
// missing, no statement provided for it) - own de-dup key (label), separate tables from the above
// (see db.js), always safe to re-run; see bob-martin/municipal_import.js for extraction notes.
require('./bob-martin/municipal_import').run('bob-martin.db');
// AutoZone's actual municipal account statements (Dec 2025, Jan/Mar/Apr/May/Jun/Jul 2026 - Feb 2026
// still missing, no statement provided for it) - own de-dup key (label), separate tables from
// the above (see db.js), always safe to re-run; see autozone/municipal_import.js for the tariff-year
// change / meter-not-read / INTERIM REVERSAL anomaly notes flagged during extraction.
require('./autozone/municipal_import').run('autozone.db');
// Loper Road - Sandvic's actual municipal account statements (Dec 2025, Jan/Feb/Mar 2026 - the only
// 4 months provided so far) - own de-dup key (label), separate tables from the above (see db.js),
// always safe to re-run; see loper-road/municipal_import.js for the extraction/reconciliation notes.
require('./loper-road/municipal_import').run('loper-road.db');
// Cranbrook Flavours' actual municipal account statements (Nov 2025, Mar/May/Jun 2026 - Dec 2025/
// Jan/Feb 2026 missing, no statement provided) - own de-dup key (label), separate tables from the
// above (see db.js), always safe to re-run; see cranbrook-flavours/municipal_import.js for the
// extraction/reconciliation notes, including the account changeover and March 2026's stretched
// ~70-day combined statement.
require('./cranbrook-flavours/municipal_import').run('cranbrook-flavours.db');

function getPropertyDb(slug) { return propertyDbs.get(slug) || propertyDbs.get(DEFAULT_PROPERTY_SLUG); }
function currentPropertyName(user) {
  const prop = properties.find((p) => p.slug === (user && user.currentProperty));
  return (prop || properties[0]).name;
}
// City Deep is billed by the City of Johannesburg, Wingfield by the City of Ekurhuleni - used only
// for display text on the municipal statement PDF/page (see municipal_compare.js's SITE_MAP for
// the actual account-to-site mapping, which doesn't need this - it just sums whatever's in each
// property's own db).
const MUNICIPALITY_BY_SLUG = { 'city-deep': 'City of Johannesburg', wingfield: 'City of Ekurhuleni' };
function currentMunicipalityName(user) {
  return MUNICIPALITY_BY_SLUG[(user && user.currentProperty) || DEFAULT_PROPERTY_SLUG] || 'the municipality';
}

// AsyncLocalStorage tracks which property's database is "active" for the duration of one request
// (set by the dispatcher at the bottom of this file, per-request, from the session's
// currentProperty) - so the ~80 existing get()/all()/run() call sites throughout this file don't
// need to be touched or passed a db handle explicitly, but two concurrent requests for two
// different properties can never see each other's connection (unlike a plain shared module-level
// variable, which a naive reassignment could race under Node's async interleaving).
const dbContext = new AsyncLocalStorage();
function currentDb() {
  const db = dbContext.getStore();
  if (!db) throw new Error('No active property database in this request context - route handler ran outside the dispatcher\'s dbContext.run().');
  return db;
}

function get(sql, params = []) { return currentDb().prepare(sql).get(...params); }
function all(sql, params = []) { return currentDb().prepare(sql).all(...params); }
function run(sql, params = []) { return currentDb().prepare(sql).run(...params); }

function audit(userId, action, entityType, entityId, field, oldValue, newValue, reason) {
  run('INSERT INTO audit_log (user_id, action, entity_type, entity_id, field, old_value, new_value, reason) VALUES (?,?,?,?,?,?,?,?)',
    [userId || null, action, entityType, entityId || null, field || null, oldValue != null ? String(oldValue) : null, newValue != null ? String(newValue) : null, reason || null]);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(querystring.parse(data)));
  });
}

// Reads the full request body into one Buffer, capped at maxBytes (default ~25MB - generous
// enough for a handful of phone photos of meter dials in one submission, without letting a
// request grow unbounded). Used by readMultipartBody below; kept separate from readBody() (which
// stays a string accumulator for normal form posts) because file uploads need raw bytes, not text.
function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Upload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal hand-rolled multipart/form-data parser (no external dependency, consistent with the
// rest of this app) - just enough to support the meter-reading photo upload form. Returns
// { fields: { name: stringValue }, files: { name: { filename, contentType, data: Buffer } } }.
// Relies on the multipart spec's guarantee that the browser-chosen boundary string can't appear
// inside any part's own content, so a plain Buffer.indexOf search for it is safe.
async function readMultipartBody(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const fields = {}, files = {};
  if (!boundaryMatch) return { fields, files };
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const buf = await readRawBody(req);

  let pos = buf.indexOf(boundary);
  if (pos === -1) return { fields, files };
  pos += boundary.length;
  while (true) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // "--" -> final boundary, done
    pos += 2; // skip the CRLF right after the boundary
    const next = buf.indexOf(boundary, pos);
    if (next === -1) break;
    const part = buf.slice(pos, next - 2); // -2 strips the CRLF just before the next boundary
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString('utf8');
      const body = part.slice(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/.exec(headerText);
      const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      const name = nameMatch ? nameMatch[1] : null;
      if (name && filenameMatch && filenameMatch[1]) {
        files[name] = { filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: body };
      } else if (name) {
        fields[name] = body.toString('utf8');
      }
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

function requireLogin(req, res) {
  const user = auth.currentUser(req);
  if (!user) { redirect(res, '/login'); return null; }
  return user;
}

function requireRole(req, res, user, allowed) {
  if (!allowed.has(user.role)) {
    send(res, 403, views.layout({ title: 'Forbidden', user, active: null, body: '<div class="bg-white border rounded p-6">You do not have permission to do this.</div>' }));
    return false;
  }
  return true;
}

// ---------------- data helpers ----------------
function latestPeriod() { return get('SELECT * FROM billing_periods ORDER BY start_date DESC LIMIT 1'); }

// Trailing up-to-12-month view of a tenant's billed cost (excl. VAT), split Electricity / Water /
// Sanitation, ending at (and including) the given period - feeds the trend chart on the PDF slip.
// Sanitation is stored under utility_type='water' in bill_line_items (it's part of the same
// municipal water/sewer account), so it's split out here by category rather than being a
// separate utility_type in the schema.
function monthlyTrendForTenant(tenantId, asOfStartDate) {
  const rows = all(`
    SELECT bp.label, bp.start_date,
      COALESCE(SUM(CASE WHEN bli.utility_type='electricity' THEN bli.amount END), 0) as elec,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category NOT IN ('sanitation','sanitation_surcharge') THEN bli.amount END), 0) as water,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category IN ('sanitation','sanitation_surcharge') THEN bli.amount END), 0) as sanitation,
      COALESCE(MAX(b.electricity_consumption_kwh), 0) as elecKwh,
      COALESCE(MAX(b.water_consumption_m3), 0) as waterM3
    FROM billing_periods bp
    LEFT JOIN bills b ON b.billing_period_id = bp.id AND b.tenant_id = ?
    LEFT JOIN bill_line_items bli ON bli.bill_id = b.id
    WHERE bp.start_date <= ?
    GROUP BY bp.id
    ORDER BY bp.start_date DESC
    LIMIT 12
  `, [tenantId, asOfStartDate]);
  return rows.reverse();
}

function dashboardData(periodId) {
  const period = periodId ? get('SELECT * FROM billing_periods WHERE id=?', [periodId]) : latestPeriod();
  const activeTenants = get("SELECT COUNT(*) c FROM tenants WHERE status='active'").c;
  const billedThisMonth = period ? get('SELECT COUNT(DISTINCT tenant_id) c FROM bills WHERE billing_period_id=?', [period.id]).c : 0;
  const draftBills = get("SELECT COUNT(*) c FROM bills WHERE status='draft'").c;
  const finalisedBills = get("SELECT COUNT(*) c FROM bills WHERE status IN ('finalised','issued')").c;
  const totals = period ? get(`SELECT
      COALESCE(SUM(CASE WHEN bli.utility_type='electricity' THEN bli.amount END),0) as elecBilled,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' THEN bli.amount END),0) as waterBilled
    FROM bill_line_items bli JOIN bills b ON b.id=bli.bill_id WHERE b.billing_period_id=?`, [period.id]) : { elecBilled: 0, waterBilled: 0 };
  const totalBilled = period ? get('SELECT COALESCE(SUM(total_incl_vat),0) t FROM bills WHERE billing_period_id=?', [period.id]).t : 0;
  const consumption = period ? get('SELECT COALESCE(SUM(electricity_consumption_kwh),0) e, COALESCE(SUM(water_consumption_m3),0) w FROM bills WHERE billing_period_id=?', [period.id]) : { e: 0, w: 0 };
  const missing = period ? all(`SELECT t.name FROM tenants t WHERE t.status='active' AND t.id NOT IN (SELECT tenant_id FROM bills WHERE billing_period_id=?)`, [period.id]).map(r => r.name) : [];
  const recentBills = all(`SELECT b.*, t.name as tenant, bp.label as period FROM bills b
    JOIN tenants t ON t.id=b.tenant_id JOIN billing_periods bp ON bp.id=b.billing_period_id
    ORDER BY b.generated_at DESC LIMIT 8`);
  const allPeriods = all('SELECT * FROM billing_periods ORDER BY start_date DESC');
  return {
    stats: {
      activeTenants, billedThisMonth, missingCount: missing.length, draftBills, finalisedBills,
      totalElecBilled: totals.elecBilled, totalWaterBilled: totals.waterBilled, totalBilled,
      totalElecKwh: consumption.e, totalWaterKl: consumption.w,
    },
    recentBills, missing, currentPeriod: period, allPeriods,
  };
}

// ---------------- routes ----------------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
}

route('GET', '/', async (req, res) => redirect(res, '/dashboard'));

route('GET', '/login', async (req, res) => {
  if (auth.currentUser(req)) return redirect(res, '/dashboard');
  send(res, 200, views.loginPage());
});
route('POST', '/login', async (req, res) => {
  const body = await readBody(req);
  // Always checked against the shared authDb, never the currently-active property's db (which
  // pre-login is just whatever DEFAULT_PROPERTY_SLUG happens to be) - see the authDb comment
  // near the top of this file for why that distinction matters.
  const u = authDb.prepare('SELECT * FROM users WHERE username=?').get(body.username || '');
  if (!u || !auth.verifyPassword(body.password || '', u.salt, u.password_hash)) {
    return send(res, 401, views.loginPage('Invalid username or password.'));
  }
  const token = auth.createSession(u, DEFAULT_PROPERTY_SLUG);
  auth.setSessionCookie(res, token);
  audit(u.id, 'login', 'user', u.id, null, null, null, null);
  redirect(res, '/dashboard');
});
route('GET', '/logout', async (req, res) => {
  const raw = auth.getCookie(req, 'sid');
  auth.clearSessionCookie(res);
  redirect(res, '/login');
});

// The nav dropdown (see views.js layout()) POSTs here on change - updates which property db the
// session's subsequent requests resolve to (see dbContext above) and bounces back to the
// referring page so switching properties feels like a toggle, not a navigation.
route('POST', '/switch-property', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const body = await readBody(req);
  const slug = properties.some((p) => p.slug === body.property) ? body.property : DEFAULT_PROPERTY_SLUG;
  auth.setCurrentProperty(req, slug);
  redirect(res, req.headers.referer || '/dashboard');
});

route('GET', '/dashboard', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;
  // The tenant/bills-oriented dashboard below doesn't mean anything for a flat_site property (see
  // properties.js) - there are no tenants or per-tenant bills to summarise, just a list of monthly
  // billing slips - so /site-billing (its own list page) stands in as this property's "dashboard".
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  if (currentProp && currentProp.billingModel === 'flat_site') return redirect(res, '/site-billing');
  const data = dashboardData(query.periodId);
  send(res, 200, views.dashboardPage({ user, ...data }));
});

route('GET', '/tenants', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const tenants = all(`SELECT t.*, s.name as site_name,
      (SELECT COUNT(DISTINCT meter_id) FROM meter_assignments WHERE tenant_id=t.id AND effective_to IS NULL) as meter_count
    FROM tenants t LEFT JOIN sites s ON s.id=t.site_id ORDER BY t.name`);
  send(res, 200, views.tenantsPage({ user, tenants }));
});

route('GET', '/tenants/:id', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const tenant = get('SELECT t.*, s.name as site_name FROM tenants t LEFT JOIN sites s ON s.id=t.site_id WHERE t.id=?', [params.id]);
  if (!tenant) return send(res, 404, 'Not found');
  const meters = all(`SELECT ma.*, m.serial, m.utility_type, m.role FROM meter_assignments ma
    JOIN meters m ON m.id=ma.meter_id WHERE ma.tenant_id=? AND ma.effective_to IS NULL ORDER BY m.utility_type, m.serial`, [tenant.id]);
  const bills = all(`SELECT b.*, bp.label FROM bills b JOIN billing_periods bp ON bp.id=b.billing_period_id
    WHERE b.tenant_id=? ORDER BY bp.start_date DESC`, [tenant.id]);
  send(res, 200, views.tenantDetailPage({ user, tenant, meters, bills }));
});

route('GET', '/meters', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const meters = all('SELECT * FROM meters ORDER BY utility_type, serial');
  send(res, 200, views.metersPage({ user, meters }));
});

route('GET', '/tariffs', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const tariffRows = all('SELECT * FROM tariffs ORDER BY utility_type, code');
  const tariffs = tariffRows.map(t => ({ ...t, versions: all('SELECT * FROM tariff_versions WHERE tariff_id=? ORDER BY effective_from DESC', [t.id]) }));
  send(res, 200, views.tariffsPage({ user, tariffs }));
});

route('GET', '/billing-periods', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const periods = all(`SELECT bp.*, (SELECT COUNT(*) FROM bills WHERE billing_period_id=bp.id) as bill_count
    FROM billing_periods bp ORDER BY bp.start_date DESC`);
  send(res, 200, views.billingPeriodsPage({ user, periods }));
});

route('GET', '/billing-periods/new', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  send(res, 200, views.newBillingPeriodPage({ user }));
});

route('POST', '/billing-periods', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const body = await readBody(req);
  const label = (body.label || '').trim();
  if (!label || !body.start_date || !body.end_date) {
    return send(res, 400, views.newBillingPeriodPage({ user, error: 'Label, start date and end date are all required.' }));
  }
  const existing = get('SELECT * FROM billing_periods WHERE label=?', [label]);
  if (existing) return send(res, 400, views.newBillingPeriodPage({ user, error: `A billing period labelled "${label}" already exists.` }));
  run('INSERT INTO billing_periods (label, start_date, end_date, invoice_date, due_date) VALUES (?,?,?,?,?)',
    [label, body.start_date, body.end_date, body.invoice_date || null, body.due_date || null]);
  const period = get('SELECT * FROM billing_periods WHERE label=?', [label]);
  audit(user.userId, 'create', 'billing_period', period.id, null, null, label, null);
  redirect(res, `/readings/${period.id}`);
});

route('GET', '/readings/:periodId', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const period = get('SELECT * FROM billing_periods WHERE id=?', [params.periodId]);
  if (!period) return send(res, 404, 'Not found');
  const assignments = all(`
    SELECT ma.*, m.serial, m.utility_type, m.unit_scale, t.id as t_id, t.name as tenant_name
    FROM meter_assignments ma JOIN meters m ON m.id=ma.meter_id JOIN tenants t ON t.id=ma.tenant_id
    WHERE ma.effective_to IS NULL ORDER BY t.name, m.utility_type, m.serial`);
  const groups = [];
  const byTenant = new Map();
  for (const a of assignments) {
    const prior = get(`SELECT mr.* FROM meter_readings mr JOIN billing_periods bp ON bp.id=mr.billing_period_id
      WHERE mr.meter_id=? AND bp.start_date<? ORDER BY bp.start_date DESC LIMIT 1`, [a.meter_id, period.start_date]);
    const existingReading = get('SELECT * FROM meter_readings WHERE meter_id=? AND billing_period_id=?', [a.meter_id, period.id]);
    const row = {
      meter_id: a.meter_id, serial: a.serial, utility_type: a.utility_type,
      unitScale: a.unit_scale || 1,
      showDemand: a.utility_type === 'electricity' && a.tariff_code === 1 && !a.energy_only,
      priorEnd: existingReading ? existingReading.start_reading : (prior ? prior.end_reading : ''),
      priorEndKvarh: existingReading ? existingReading.start_reading_kvarh : (prior ? prior.end_reading_kvarh : ''),
      photoPath: existingReading ? existingReading.photo_path : null,
      // Only a *manually* captured reading is safe to offer "Delete" on - an excel_import
      // reading is a historical, reconciled figure from an uploaded workbook, not test data (see
      // POST /readings/:periodId/delete/:meterId below, which enforces this server-side too).
      canDelete: !!existingReading && existingReading.source === 'manual',
    };
    if (!byTenant.has(a.t_id)) { const g = { tenant: { id: a.t_id, name: a.tenant_name }, meters: [] }; byTenant.set(a.t_id, g); groups.push(g); }
    byTenant.get(a.t_id).meters.push(row);
  }
  send(res, 200, views.readingsCapturePage({ user, period, groups }));
});

route('POST', '/readings/:periodId', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const period = get('SELECT * FROM billing_periods WHERE id=?', [params.periodId]);
  if (!period) return send(res, 404, 'Not found');
  // The capture form now posts multipart/form-data (so it can carry an optional meter photo
  // alongside the reading numbers) - fall back to the old urlencoded parser for safety if a
  // client ever posts here without a file input at all.
  const isMultipart = /^multipart\/form-data/i.test(req.headers['content-type'] || '');
  const { fields: body, files } = isMultipart ? await readMultipartBody(req) : { fields: await readBody(req), files: {} };
  const assignments = all('SELECT meter_id FROM meter_assignments WHERE effective_to IS NULL');
  const propertySlug = user.currentProperty || DEFAULT_PROPERTY_SLUG;
  let saved = 0;
  for (const a of assignments) {
    const endVal = body[`end_${a.meter_id}`];
    if (endVal === undefined || endVal === '') continue;
    const startVal = body[`start_${a.meter_id}`];
    const kva = body[`kva_${a.meter_id}`];
    const kvarhEnd = body[`kvarh_end_${a.meter_id}`];
    const existing = get('SELECT * FROM meter_readings WHERE meter_id=? AND billing_period_id=?', [a.meter_id, period.id]);
    const startReading = startVal !== undefined && startVal !== '' ? Number(startVal) : (existing ? existing.start_reading : 0);
    const startKvarh = existing ? existing.start_reading_kvarh : null;
    const uploadedPhoto = files[`photo_${a.meter_id}`];
    const newPhotoPath = uploadedPhoto ? saveMeterPhoto(propertySlug, a.meter_id, period.id, uploadedPhoto) : null;
    if (newPhotoPath && existing && existing.photo_path) deleteMeterPhoto(existing.photo_path); // replaced, not added to
    const photoPath = newPhotoPath || (existing ? existing.photo_path : null);
    run(`INSERT INTO meter_readings (meter_id, billing_period_id, start_reading, end_reading, start_reading_kvarh, end_reading_kvarh, kva_reading, source, entered_by, photo_path)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(meter_id, billing_period_id) DO UPDATE SET
           start_reading=excluded.start_reading, end_reading=excluded.end_reading,
           start_reading_kvarh=excluded.start_reading_kvarh, end_reading_kvarh=excluded.end_reading_kvarh,
           kva_reading=excluded.kva_reading, source=excluded.source, entered_by=excluded.entered_by,
           photo_path=excluded.photo_path`,
      [a.meter_id, period.id, startReading, Number(endVal), startKvarh, kvarhEnd ? Number(kvarhEnd) : null, kva ? Number(kva) : 0, 'manual', user.userId, photoPath]);
    saved++;
  }
  const result = billing.generateBillsForPeriod(currentDb(), period.id);
  audit(user.userId, 'capture_readings', 'billing_period', period.id, null, null, `${saved} readings saved, ${result.billsCreated} bills generated`, null);
  send(res, 200, views.readingsResultPage({ user, period, result }));
});

// Deletes a single manually-captured reading - built for testing the manual-capture flow (add a
// reading, see how the bill comes out, delete it, try again) without leaving stray draft bills
// or orphaned photo files behind. Deliberately refuses to touch anything sourced from an Excel
// import: those are historical, reconciled figures, not test data, and this button never even
// renders for them (see readingsCapturePage's canDelete) - this check is the server-side backstop.
route('POST', '/readings/:periodId/delete/:meterId', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const period = get('SELECT * FROM billing_periods WHERE id=?', [params.periodId]);
  if (!period) return send(res, 404, 'Not found');
  const meterId = Number(params.meterId);
  const reading = get('SELECT * FROM meter_readings WHERE meter_id=? AND billing_period_id=?', [meterId, period.id]);
  if (reading && reading.source === 'manual') {
    deleteMeterPhoto(reading.photo_path);
    const assignment = get('SELECT tenant_id FROM meter_assignments WHERE meter_id=? AND effective_to IS NULL', [meterId]);
    run('DELETE FROM meter_readings WHERE meter_id=? AND billing_period_id=?', [meterId, period.id]);
    if (assignment) {
      // Whatever bill this tenant had for this period was computed partly (or entirely) from the
      // reading just deleted, so it's stale either way - clear it out rather than leave a bill on
      // the books that no longer matches any captured reading. generateBillsForPeriod below will
      // rebuild it cleanly from whatever readings (if any) remain for this tenant.
      run('DELETE FROM bill_line_items WHERE bill_id IN (SELECT id FROM bills WHERE tenant_id=? AND billing_period_id=?)', [assignment.tenant_id, period.id]);
      run('DELETE FROM bills WHERE tenant_id=? AND billing_period_id=?', [assignment.tenant_id, period.id]);
    }
    billing.generateBillsForPeriod(currentDb(), period.id);
    audit(user.userId, 'delete_reading', 'meter_reading', meterId, null, null, null, `Deleted manual reading for meter ${meterId}, period ${period.label}`);
  }
  redirect(res, `/readings/${period.id}`);
});

// ---------------- flat_site billing (8 Field Street, Bob Martin, Loper Road - Sandvic, AutoZone,
// Cranbrook Flavours) ----------------
// See properties.js's billingModel and db.js's site_tariffs/site_tariff_items/site_billing_slips/
// site_slip_readings for why this is a separate small set of routes rather than reusing the
// tenant/billing_period machinery above. Fully data-driven off whatever line items the site's
// current tariff defines (see calc_flat_site.js) - no site-specific code lives here anymore.

function getTariffItems(tariffId) {
  return all('SELECT * FROM site_tariff_items WHERE tariff_id=? ORDER BY sort_order', [tariffId]);
}
function getSlipReadings(slipId) {
  const rows = all('SELECT * FROM site_slip_readings WHERE slip_id=?', [slipId]);
  const map = {};
  for (const r of rows) map[r.item_key] = { reading: r.reading, comment: r.comment };
  return map;
}
const FACTOR_COLS = ['kva_factor', 'peak_factor', 'standard_factor', 'offpeak_factor'];

// Reuses an existing site_tariffs row if one already has these exact rates/factors for this site's
// exact item set (e.g. saving a slip without touching the tariff section), otherwise inserts a new
// version - this is what makes "the rate should reflect the tariff for each new month" work: each
// month's slip just carries whichever tariff row matches what was typed in, new or old. `template`
// is the ordered site_tariff_items list this site is currently on (label/unit/section/factor_type/
// fixed_reading/has_comment never change between versions of the same site - only rate/factor
// values do), `body` is the submitted form fields (rate__<key>, kva_factor, etc).
function findOrCreateSiteTariff(templateTariff, template, body, effectiveFrom) {
  const newRates = {};
  for (const it of template) newRates[it.item_key] = Number(body[`rate__${it.item_key}`]) || 0;
  const newFactors = {};
  for (const c of FACTOR_COLS) newFactors[c] = Number(body[c]) || 1;

  const existingTariffs = all('SELECT * FROM site_tariffs ORDER BY id DESC');
  for (const t of existingTariffs) {
    if (!FACTOR_COLS.every((c) => Math.abs((t[c] || 1) - newFactors[c]) < 1e-9)) continue;
    const items = getTariffItems(t.id);
    if (items.length !== template.length) continue;
    const ratesMatch = items.every((it) => Math.abs((it.rate || 0) - (newRates[it.item_key] ?? NaN)) < 1e-9);
    if (ratesMatch) return t.id;
  }

  // tariff_name is a site-level constant (e.g. "City_Power_Industrial_LV_TOU_Incl_Surcharge") -
  // there's no form field for it, it just carries forward from whichever tariff this slip started from.
  run(`INSERT INTO site_tariffs (tariff_name, effective_from, ${FACTOR_COLS.join(', ')}) VALUES (?,?,?,?,?,?)`,
    [templateTariff.tariff_name || null, effectiveFrom, newFactors.kva_factor, newFactors.peak_factor, newFactors.standard_factor, newFactors.offpeak_factor]);
  const tariffId = get('SELECT id FROM site_tariffs ORDER BY id DESC LIMIT 1').id;
  template.forEach((it, i) => {
    run(`INSERT INTO site_tariff_items (tariff_id, sort_order, section, item_key, label, unit, rate, factor_type, fixed_reading, has_comment)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tariffId, i, it.section, it.item_key, it.label, it.unit, newRates[it.item_key], it.factor_type, it.fixed_reading, it.has_comment ? 1 : 0]);
  });
  return tariffId;
}

// Generates every 'YYYY-MM' label from startLabel to endLabel inclusive - used to fill trend-chart
// series with an explicit blank entry for a calendar month that has no slip at all (e.g. 8 Field
// Street's municipal account is missing an April 2026 statement - see field-street/
// municipal_import.js), so the PDF chart shows a genuine gap there instead of silently closing the
// gap by butting March straight up against May.
function monthLabelRange(startLabel, endLabel) {
  const labels = [];
  let [y, m] = startLabel.split('-').map(Number);
  const [endY, endM] = endLabel.split('-').map(Number);
  while (y < endY || (y === endY && m <= endM)) {
    labels.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return labels;
}

// elecKwh sums every row tagged unit R/kWh (matches by unit, not key/factor_type - a municipal
// statement's items never carry a factor_type at all, since there's nothing to gross up on the
// municipality's own meter reading, so filtering on factor_type would silently zero out every
// municipal consumption figure; matching by key prefix alone used to miss Loper Road's non-TOU
// shapes, which use a flat 'energy_charge' key on the municipal side and 'total_energy_high'/
// 'total_energy_low' on the site side from July 2026 - see flat_site_tariff_shapes.js). Excludes
// AutoZone's Network Surcharge row (key 'network_surcharge', also unit R/kWh, but its "reading" is
// a copy of that month's total metered kWh, not an independent consumption figure - see
// autozone/municipal_import.js) and every municipal-only row (property_rates, refuse - unit R/c,
// not R/kWh).
function sumElecKwh(elecItems) {
  return elecItems.filter((i) => i.unit === 'R/kWh' && i.key !== 'network_surcharge')
    .reduce((s, i) => s + i.adjustedReading, 0);
}

// Trailing-12-actual-statement view of this site's own cost + consumption, for the PDF's trend
// charts (see drawTripleTrendCharts/drawConsumptionTrendCharts in pdf.js, reused as-is from the
// tenant billing slip - Sewer is passed in the `sanitation` slot since those charts were built
// around Electricity/Water/Sanitation and the shapes line up one-for-one). Fills any calendar-month
// gap between the earliest and latest of those 12 with a blank ({elec: null, ...}) entry rather
// than skipping it, so pdf.js's chart drawing can render an empty column instead of closing the gap.
function monthlyTrendForSite(asOfStartDate) {
  const slips = all(`SELECT s.* FROM site_billing_slips s
    WHERE s.start_date<=? ORDER BY s.start_date DESC LIMIT 12`, [asOfStartDate]);
  const ordered = slips.reverse();
  if (!ordered.length) return [];
  const byLabel = new Map(ordered.map((s) => [s.label, s]));
  return monthLabelRange(ordered[0].label, ordered[ordered.length - 1].label).map((label) => {
    const slip = byLabel.get(label);
    if (!slip) return { label, elec: null, water: null, sanitation: null, elecKwh: null, waterM3: null };
    const tariff = get('SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
    const items = getTariffItems(slip.tariff_id);
    const readings = getSlipReadings(slip.id);
    const { elecTotal, elecItems, waterItems } = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
    const waterItem = waterItems.find((i) => i.key === 'water');
    const sewerItem = waterItems.find((i) => i.key === 'sewer');
    return {
      label,
      elec: elecTotal, water: waterItem ? waterItem.cost : 0, sanitation: sewerItem ? sewerItem.cost : 0,
      elecKwh: sumElecKwh(elecItems), waterM3: waterItem ? waterItem.reading : 0,
    };
  });
}

// Combines two monthlyTrend series (site + municipal, either order) into one Y-axis max per
// category - used so the client billing PDF and the municipal statement PDF for the same property
// share one scale per chart (see pdf.js's drawSingleSeriesChart maxOverride) instead of each PDF
// silently rescaling to its own numbers, which made a bar impossible to compare by eye between the
// two documents. Properties with no municipal data (Loper Road, Cranbrook Flavours) simply get an
// empty seriesB here, so this is a no-op there - the max just comes from seriesA as before.
function combinedAxisMax(seriesA, seriesB, keys) {
  const overrides = {};
  for (const key of keys) {
    const values = [...(seriesA || []), ...(seriesB || [])]
      .map((s) => s[key]).filter((v) => v != null);
    overrides[key] = Math.max(1, ...values, 0);
  }
  return overrides;
}

route('GET', '/site-billing', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const slips = all('SELECT * FROM site_billing_slips ORDER BY start_date DESC');
  const rows = slips.map((slip) => {
    const tariff = get('SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
    const items = getTariffItems(slip.tariff_id);
    const readings = getSlipReadings(slip.id);
    return { row: slip, calc: calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor) };
  });
  send(res, 200, views.siteBillingListPage({ user, rows }));
});

route('GET', '/site-billing/new', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const latestTariff = get('SELECT * FROM site_tariffs ORDER BY id DESC LIMIT 1');
  if (!latestTariff) return send(res, 400, 'This property has no tariff yet - it needs an initial seed/import script before slips can be added.');
  const latestSlip = get('SELECT * FROM site_billing_slips ORDER BY start_date DESC LIMIT 1');
  const items = getTariffItems(latestTariff.id);
  send(res, 200, views.siteBillingFormPage({ user, tariff: latestTariff, items, readings: {}, slip: null, latestSlip }));
});

route('GET', '/site-billing/:id/edit', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const slip = get('SELECT * FROM site_billing_slips WHERE id=?', [params.id]);
  if (!slip) return send(res, 404, 'Not found');
  const tariff = get('SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
  const items = getTariffItems(slip.tariff_id);
  const readings = getSlipReadings(slip.id);
  send(res, 200, views.siteBillingFormPage({ user, tariff, items, readings, slip, latestSlip: null }));
});

async function saveSiteBillingSlip(req, res, existingId) {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const body = await readBody(req);
  const label = (body.label || '').trim();
  const startDate = body.start_date, endDate = body.end_date;
  // Template item list: the tariff this slip is already on (editing), or the site's latest tariff
  // (new slip) - either way, whichever tariff a sibling slip on this same property most recently
  // used, since that's the only place the site's line-item shape is known.
  const templateTariffId = existingId
    ? get('SELECT tariff_id FROM site_billing_slips WHERE id=?', [existingId]).tariff_id
    : get('SELECT id FROM site_tariffs ORDER BY id DESC LIMIT 1').id;
  const templateTariff = get('SELECT * FROM site_tariffs WHERE id=?', [templateTariffId]);
  const template = getTariffItems(templateTariffId);
  if (!label || !startDate || !endDate) {
    return send(res, 400, views.siteBillingFormPage({
      user, tariff: { ...body }, items: template, readings: {}, slip: { ...body, id: existingId }, latestSlip: null,
      error: 'Label, start date and end date are all required.',
    }));
  }
  const tariffId = findOrCreateSiteTariff(templateTariff, template, body, startDate);
  // Checkboxes only appear in the POST body at all when checked ("apply_correction_factor=1"); an
  // unchecked box simply isn't sent, so its absence here means "off", not "unset".
  const applyCorrectionFactor = body.apply_correction_factor ? 1 : 0;

  let slipId = existingId;
  if (existingId) {
    run('UPDATE site_billing_slips SET label=?, start_date=?, end_date=?, tariff_id=?, apply_correction_factor=? WHERE id=?',
      [label, startDate, endDate, tariffId, applyCorrectionFactor, existingId]);
    audit(user.userId, 'update', 'site_billing_slip', existingId, null, null, label, null);
  } else {
    run('INSERT INTO site_billing_slips (label, start_date, end_date, tariff_id, apply_correction_factor, entered_by) VALUES (?,?,?,?,?,?)',
      [label, startDate, endDate, tariffId, applyCorrectionFactor, user.userId]);
    slipId = get('SELECT id FROM site_billing_slips WHERE label=?', [label]).id;
    audit(user.userId, 'create', 'site_billing_slip', slipId, null, null, label, null);
  }
  for (const it of template) {
    if (it.fixed_reading != null) continue; // nothing to save - always the same fixed value
    const reading = Number(body[`reading__${it.item_key}`]) || 0;
    const comment = it.has_comment ? (body[`comment__${it.item_key}`] || null) : null;
    run(`INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,?)
      ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading, comment=excluded.comment`,
      [slipId, it.item_key, reading, comment]);
  }
  redirect(res, `/site-billing/${slipId}`);
}

route('POST', '/site-billing/new', async (req, res) => saveSiteBillingSlip(req, res, null));
route('POST', '/site-billing/:id/edit', async (req, res, params) => saveSiteBillingSlip(req, res, Number(params.id)));

route('GET', '/site-billing/:id', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const slip = get('SELECT * FROM site_billing_slips WHERE id=?', [params.id]);
  if (!slip) return send(res, 404, 'Not found');
  const tariff = get('SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
  const items = getTariffItems(slip.tariff_id);
  const readings = getSlipReadings(slip.id);
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  send(res, 200, views.siteBillingDetailPage({ user, slip, tariff, calc, propertyName: currentPropertyName(user) }));
});

route('POST', '/site-billing/:id/delete', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const slip = get('SELECT * FROM site_billing_slips WHERE id=?', [params.id]);
  if (slip) {
    run('DELETE FROM site_slip_readings WHERE slip_id=?', [params.id]);
    run('DELETE FROM site_billing_slips WHERE id=?', [params.id]);
    audit(user.userId, 'delete', 'site_billing_slip', slip.id, null, null, null, `Deleted site billing slip ${slip.label}`);
  }
  redirect(res, '/site-billing');
});

route('GET', '/site-billing-pdf/:id', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const slip = get('SELECT * FROM site_billing_slips WHERE id=?', [params.id]);
  if (!slip) return send(res, 404, 'Not found');
  const tariff = get('SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
  const items = getTariffItems(slip.tariff_id);
  const readings = getSlipReadings(slip.id);
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  const monthlyTrend = monthlyTrendForSite(slip.start_date);
  // Same-scale axis vs this property's municipal statement PDF (see combinedAxisMax above) - an
  // empty municipal trend (no municipal_import.js for this property) just leaves the scale as
  // monthlyTrend's own max, so this is harmless for Loper Road/Cranbrook Flavours too.
  const municipalTrendForAxis = monthlyTrendForMunicipal(slip.start_date);
  const axisMaxOverrides = {
    cost: combinedAxisMax(monthlyTrend, municipalTrendForAxis, ['elec', 'water', 'sanitation']),
    consumption: combinedAxisMax(monthlyTrend, municipalTrendForAxis, ['elecKwh', 'waterM3']),
  };
  const propertyName = currentPropertyName(user);
  const pdfBuf = buildSiteBillingSlipPdf({
    propertyName, slip, tariff, calc, monthlyTrend, axisMaxOverrides,
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });
  audit(user.userId, 'pdf_download', 'site_billing_slip', slip.id, null, null, null, slip.label);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-${slip.label}.pdf"` });
  res.end(pdfBuf);
});

// One combined PDF with every month's Billing Slip summary page (no trend-chart pages) - added
// 2026-08-11 so the client can print every month at once instead of downloading each one
// separately and using a PDF viewer's custom page-range print. Oldest-first, same convention as
// every trend chart in this app, so a printed/bound stack reads in natural chronological order.
route('GET', '/site-billing-pdf-all', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const slips = all('SELECT * FROM site_billing_slips ORDER BY start_date ASC');
  const propertyName = currentPropertyName(user);
  const entries = slips.map((slip) => {
    const tariff = get('SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
    const items = getTariffItems(slip.tariff_id);
    const readings = getSlipReadings(slip.id);
    const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
    return { propertyName, slip, tariff, calc, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  });
  const pdfBuf = buildSiteBillingSlipsCombinedPdf(entries);
  audit(user.userId, 'pdf_download', 'site_billing_slip', null, null, null, null, `combined:${entries.length} slips`);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-billing-slips-all.pdf"` });
  res.end(pdfBuf);
});

// ---------------- recovery: tenant billing vs municipal statement ----------------
// Only meaningful for a property with both its own client billing AND a real municipal statement
// to compare against. Two independent backing implementations share this one pair of routes -
// flat_site_recovery.js (label-matched, gated by properties.js's hasMunicipalStatements) for the
// flat_site properties, tenant_recovery.js (date-overlap matched, gated by recoverySiteName) for
// tenant-model properties like Wingfield - see each module's own header comment for why the
// matching method differs. Guarded the same way the dashboard redirect above guards billingModel: a
// direct hit on either route from a property without the relevant flag just bounces to /dashboard
// instead of rendering an all-"no data" page.
// Returns an array of { title, rows } sections - always an array so views.js/pdf.js only ever have
// one shape to render, regardless of whether a property has one Recovery section (flat_site
// properties, Wingfield) or several (City Deep - see properties.js's recoveryMultiSection flag and
// city-deep/recovery_groups.js). `title` is null for a single-section property, which the view/PDF
// layer renders as no heading at all - so this refactor is a strict no-op for every property that
// isn't City Deep.
function currentPropRecoverySections(user) {
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  if (!currentProp) return null;
  if (currentProp.billingModel === 'flat_site' && currentProp.hasMunicipalStatements) {
    return [{ title: null, rows: flatSiteRecovery.buildRecoveryRows(currentDb(), { limit: 12 }) }];
  }
  if (currentProp.recoveryMultiSection) {
    const db = currentDb();
    return cityDeepRecoveryGroups.SECTIONS.map((sec) => ({
      title: sec.title,
      // Industrial Park and Mini Park each get a solar-cost deduction (see city-deep/solar_cost.js);
      // Rittle's own solarCostForSection resolves to an always-0 function, so this is harmless there.
      rows: tenantRecovery.buildRecoveryRowsForTenants(
        db, sec.siteNameForMunicipal, cityDeepRecoveryGroups.tenantNamesForSection(db, sec.key),
        { limit: 12, solarCostForLabel: solarCost.solarCostForSection(db, sec.key) },
      ),
    }));
  }
  if (currentProp.recoverySiteName) {
    return [{ title: null, rows: tenantRecovery.buildRecoveryRows(currentDb(), currentProp.recoverySiteName, { limit: 12 }) }];
  }
  return null;
}

route('GET', '/recovery', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const sections = currentPropRecoverySections(user);
  if (!sections) return redirect(res, '/dashboard');
  send(res, 200, views.recoveryPage({ user, sections, propertyName: currentPropertyName(user) }));
});

route('GET', '/recovery-pdf', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const sections = currentPropRecoverySections(user);
  if (!sections) return redirect(res, '/dashboard');
  const propertyName = currentPropertyName(user);
  const pdfBuf = buildRecoveryPdf({ propertyName, sections, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') });
  audit(user.userId, 'pdf_download', 'recovery', null, null, null, null, null);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-recovery.pdf"` });
  res.end(pdfBuf);
});

// ---------------- flagging: utility consumption exception reporting for RPI ----------------
// Internal review/reporting tool only (see flagging.js's header comment) - never touches tenant
// billing. Gated by properties.js's hasFlagging flag - piloted on City Deep alone (confirmed with
// the client 2026-08-24), then rolled out to every property (2026-08-25). Each billingModel has its
// own data layer (buildAllFlagRows(db, settings, ...) -> { municipalRows, sectionRows, tenantRows },
// same shape from all three so views.js/pdf.js never need to know which property they're rendering
// for): city-deep/flagging_data.js needs its own branch since City Deep alone has 4 municipal
// accounts across 3 Recovery sections (see recovery_groups.js); every other tenant-model property
// (currently just Wingfield) uses wingfield/flagging_data.js's simpler single-account/single-section
// shape; every flat_site property shares flat_site_flagging_data.js (no tenants at all - see that
// module's own header comment).
function currentPropFlagRows(user) {
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  if (!currentProp || !currentProp.hasFlagging) return null;
  const db = currentDb();
  const settings = flagging.getSettings(db);
  const propertyName = currentPropertyName(user);
  if (currentProp.slug === 'city-deep') {
    return { settings, ...cityDeepFlagging.buildAllFlagRows(db, settings) };
  }
  if (currentProp.billingModel === 'flat_site') {
    return { settings, ...flatSiteFlagging.buildAllFlagRows(db, settings, propertyName, !!currentProp.hasMunicipalStatements) };
  }
  return { settings, ...wingfieldFlagging.buildAllFlagRows(db, settings, propertyName) };
}

route('GET', '/flagging', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const data = currentPropFlagRows(user);
  if (!data) return redirect(res, '/dashboard');
  // Chart-based layout prototype (see properties.js's flaggingChartLayout, views.js's chartSection) -
  // piloting on AutoZone only until reviewed.
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  const useCharts = !!(currentProp && currentProp.flaggingChartLayout);
  send(res, 200, views.flaggingPage({ user, propertyName: currentPropertyName(user), useCharts, ...data }));
});

route('GET', '/flagging-pdf', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const data = currentPropFlagRows(user);
  if (!data) return redirect(res, '/dashboard');
  const propertyName = currentPropertyName(user);
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  const useCharts = !!(currentProp && currentProp.flaggingChartLayout);
  const pdfBuf = buildFlaggingReportPdf({ propertyName, useCharts, ...data, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') });
  audit(user.userId, 'pdf_download', 'flagging_report', null, null, null, null, null);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-flagging-exceptions.pdf"` });
  res.end(pdfBuf);
});

// Save/update the HolmStone+RPI review trail for one flag (see db.js's flag_annotations) - upsert
// keyed by the natural (entity_type, entity_key, utility_type, period_label) identity, same pattern
// every other de-duped import in this app uses, just triggered by a form submit instead of a boot
// script.
route('POST', '/flagging/comment', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  if (!currentProp || !currentProp.hasFlagging) return redirect(res, '/dashboard');
  const body = await readBody(req);
  const validStatuses = ['Open', 'Under Review', 'Explained', 'Municipality Query Required', 'Corrected', 'Closed'];
  const status = validStatuses.includes(body.status) ? body.status : 'Open';
  run(`INSERT INTO flag_annotations (entity_type, entity_key, utility_type, period_label, holmstone_comment, rpi_comment, status, resolution_date)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_type, entity_key, utility_type, period_label) DO UPDATE SET
      holmstone_comment=excluded.holmstone_comment, rpi_comment=excluded.rpi_comment,
      status=excluded.status, resolution_date=excluded.resolution_date, updated_at=datetime('now')`,
    [body.entity_type, body.entity_key, body.utility_type, body.period_label,
     body.holmstone_comment || null, body.rpi_comment || null, status, body.resolution_date || null]);
  audit(user.userId, 'update', 'flag_annotation', null, 'status', null, status, `${body.entity_type}:${body.entity_key}:${body.utility_type}:${body.period_label}`);
  redirect(res, '/flagging');
});

route('GET', '/flagging/settings', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  if (!currentProp || !currentProp.hasFlagging) return redirect(res, '/dashboard');
  const settings = flagging.getSettings(currentDb());
  send(res, 200, views.flaggingSettingsPage({ user, propertyName: currentPropertyName(user), settings }));
});

route('POST', '/flagging/settings', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const currentProp = properties.find((p) => p.slug === user.currentProperty);
  if (!currentProp || !currentProp.hasFlagging) return redirect(res, '/dashboard');
  const body = await readBody(req);
  const updates = {};
  for (const key of Object.keys(flagging.DEFAULT_SETTINGS)) {
    if (body[key] != null && body[key] !== '' && Number.isFinite(Number(body[key]))) updates[key] = Number(body[key]);
  }
  flagging.updateSettings(currentDb(), updates);
  audit(user.userId, 'update', 'flag_settings', null, null, null, null, JSON.stringify(updates));
  redirect(res, '/flagging/settings');
});

// ---------------- municipal account statements (flat_site properties) ----------------
// The actual municipality invoice (e.g. Ekurhuleni), as opposed to /site-billing above (what
// HolmStone bills the client). See db.js's municipal_tariffs/municipal_tariff_items/
// municipal_statement_slips/municipal_statement_readings for why this is a fully separate set of
// tables - mirrors the /site-billing routes above almost exactly, reusing the same
// calcFlatSite.computeSlip() and buildSiteBillingSlipPdf() since the row shapes are identical by
// design (see municipal_seed_helpers.js).

function getMunicipalTariffItems(tariffId) {
  return all('SELECT * FROM municipal_tariff_items WHERE tariff_id=? ORDER BY sort_order', [tariffId]);
}
function getMunicipalStatementReadings(slipId) {
  const rows = all('SELECT * FROM municipal_statement_readings WHERE slip_id=?', [slipId]);
  const map = {};
  for (const r of rows) map[r.item_key] = { reading: r.reading, comment: r.comment };
  return map;
}

function findOrCreateMunicipalTariff(templateTariff, template, body, effectiveFrom) {
  const newRates = {};
  for (const it of template) newRates[it.item_key] = Number(body[`rate__${it.item_key}`]) || 0;
  const newFactors = {};
  for (const c of FACTOR_COLS) newFactors[c] = Number(body[c]) || 1;

  const existingTariffs = all('SELECT * FROM municipal_tariffs ORDER BY id DESC');
  for (const t of existingTariffs) {
    if (!FACTOR_COLS.every((c) => Math.abs((t[c] || 1) - newFactors[c]) < 1e-9)) continue;
    const items = getMunicipalTariffItems(t.id);
    if (items.length !== template.length) continue;
    const ratesMatch = items.every((it) => Math.abs((it.rate || 0) - (newRates[it.item_key] ?? NaN)) < 1e-9);
    if (ratesMatch) return t.id;
  }

  run(`INSERT INTO municipal_tariffs (tariff_name, effective_from, ${FACTOR_COLS.join(', ')}) VALUES (?,?,?,?,?,?)`,
    [templateTariff.tariff_name || null, effectiveFrom, newFactors.kva_factor, newFactors.peak_factor, newFactors.standard_factor, newFactors.offpeak_factor]);
  const tariffId = get('SELECT id FROM municipal_tariffs ORDER BY id DESC LIMIT 1').id;
  template.forEach((it, i) => {
    run(`INSERT INTO municipal_tariff_items (tariff_id, sort_order, section, item_key, label, unit, rate, factor_type, fixed_reading, has_comment, vat_exempt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tariffId, i, it.section, it.item_key, it.label, it.unit, newRates[it.item_key], it.factor_type, it.fixed_reading, it.has_comment ? 1 : 0, it.vat_exempt ? 1 : 0]);
  });
  return tariffId;
}

// Same trailing-view + gap-filling as monthlyTrendForSite (see monthLabelRange/sumElecKwh above) -
// 8 Field Street's municipal account is missing an April 2026 statement (no PDF was provided for
// it), so this is exactly the case that needed a real blank column instead of March butting
// straight up against May.
function monthlyTrendForMunicipal(asOfStartDate) {
  const slips = all(`SELECT s.* FROM municipal_statement_slips s
    WHERE s.start_date<=? ORDER BY s.start_date DESC LIMIT 12`, [asOfStartDate]);
  const ordered = slips.reverse();
  if (!ordered.length) return [];
  const byLabel = new Map(ordered.map((s) => [s.label, s]));
  return monthLabelRange(ordered[0].label, ordered[ordered.length - 1].label).map((label) => {
    const slip = byLabel.get(label);
    if (!slip) return { label, elec: null, water: null, sanitation: null, elecKwh: null, waterM3: null };
    const tariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
    const items = getMunicipalTariffItems(slip.tariff_id);
    const readings = getMunicipalStatementReadings(slip.id);
    const { elecTotal, elecItems, waterItems } = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
    const waterItem = waterItems.find((i) => i.key === 'water');
    const sewerItem = waterItems.find((i) => i.key === 'sewer');
    return {
      label,
      elec: elecTotal, water: waterItem ? waterItem.cost : 0, sanitation: sewerItem ? sewerItem.cost : 0,
      elecKwh: sumElecKwh(elecItems), waterM3: waterItem ? waterItem.reading : 0,
    };
  });
}

route('GET', '/municipal-billing', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const slips = all('SELECT * FROM municipal_statement_slips ORDER BY start_date DESC');
  const rows = slips.map((slip) => {
    const tariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
    const items = getMunicipalTariffItems(slip.tariff_id);
    const readings = getMunicipalStatementReadings(slip.id);
    return { row: slip, calc: calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor) };
  });
  send(res, 200, views.siteBillingListPage({
    user, rows, basePath: '/municipal-billing', pageTitle: 'Municipal Account Statements',
    newLabel: '+ New statement', emptyLabel: '"+ New statement"',
  }));
});

route('GET', '/municipal-billing/new', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const latestTariff = get('SELECT * FROM municipal_tariffs ORDER BY id DESC LIMIT 1');
  if (!latestTariff) return send(res, 400, 'This property has no municipal tariff yet - it needs an initial import script before statements can be added.');
  const latestSlip = get('SELECT * FROM municipal_statement_slips ORDER BY start_date DESC LIMIT 1');
  const items = getMunicipalTariffItems(latestTariff.id);
  send(res, 200, views.siteBillingFormPage({
    user, tariff: latestTariff, items, readings: {}, slip: null, latestSlip,
    basePath: '/municipal-billing', pageTitle: 'municipal account statement', backLabel: 'Municipal Account Statements',
    helpText: 'Enter the figures exactly as printed on the municipality\'s statement. Cost is calculated automatically from Rate \xd7 Reading. Rates carry over from the last statement by default; only change them for a month where the municipal tariff actually changed - a new tariff version is only created when a rate here differs from every version already on file.',
  }));
});

route('GET', '/municipal-billing/:id/edit', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const slip = get('SELECT * FROM municipal_statement_slips WHERE id=?', [params.id]);
  if (!slip) return send(res, 404, 'Not found');
  const tariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
  const items = getMunicipalTariffItems(slip.tariff_id);
  const readings = getMunicipalStatementReadings(slip.id);
  send(res, 200, views.siteBillingFormPage({
    user, tariff, items, readings, slip, latestSlip: null,
    basePath: '/municipal-billing', pageTitle: 'municipal account statement', backLabel: 'Municipal Account Statements',
  }));
});

async function saveMunicipalStatement(req, res, existingId) {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const body = await readBody(req);
  const label = (body.label || '').trim();
  const startDate = body.start_date, endDate = body.end_date;
  const templateTariffId = existingId
    ? get('SELECT tariff_id FROM municipal_statement_slips WHERE id=?', [existingId]).tariff_id
    : get('SELECT id FROM municipal_tariffs ORDER BY id DESC LIMIT 1').id;
  const templateTariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [templateTariffId]);
  const template = getMunicipalTariffItems(templateTariffId);
  if (!label || !startDate || !endDate) {
    return send(res, 400, views.siteBillingFormPage({
      user, tariff: { ...body }, items: template, readings: {}, slip: { ...body, id: existingId }, latestSlip: null,
      basePath: '/municipal-billing', pageTitle: 'municipal account statement', backLabel: 'Municipal Account Statements',
      error: 'Label, start date and end date are all required.',
    }));
  }
  const tariffId = findOrCreateMunicipalTariff(templateTariff, template, body, startDate);
  const applyCorrectionFactor = body.apply_correction_factor ? 1 : 0;

  let slipId = existingId;
  if (existingId) {
    run('UPDATE municipal_statement_slips SET label=?, start_date=?, end_date=?, tariff_id=?, apply_correction_factor=? WHERE id=?',
      [label, startDate, endDate, tariffId, applyCorrectionFactor, existingId]);
    audit(user.userId, 'update', 'municipal_statement_slip', existingId, null, null, label, null);
  } else {
    run('INSERT INTO municipal_statement_slips (label, start_date, end_date, tariff_id, apply_correction_factor, entered_by) VALUES (?,?,?,?,?,?)',
      [label, startDate, endDate, tariffId, applyCorrectionFactor, user.userId]);
    slipId = get('SELECT id FROM municipal_statement_slips WHERE label=?', [label]).id;
    audit(user.userId, 'create', 'municipal_statement_slip', slipId, null, null, label, null);
  }
  for (const it of template) {
    if (it.fixed_reading != null) continue;
    const reading = Number(body[`reading__${it.item_key}`]) || 0;
    const comment = it.has_comment ? (body[`comment__${it.item_key}`] || null) : null;
    run(`INSERT INTO municipal_statement_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,?)
      ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading, comment=excluded.comment`,
      [slipId, it.item_key, reading, comment]);
  }
  redirect(res, `/municipal-billing/${slipId}`);
}

route('POST', '/municipal-billing/new', async (req, res) => saveMunicipalStatement(req, res, null));
route('POST', '/municipal-billing/:id/edit', async (req, res, params) => saveMunicipalStatement(req, res, Number(params.id)));

route('GET', '/municipal-billing/:id', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const slip = get('SELECT * FROM municipal_statement_slips WHERE id=?', [params.id]);
  if (!slip) return send(res, 404, 'Not found');
  const tariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
  const items = getMunicipalTariffItems(slip.tariff_id);
  const readings = getMunicipalStatementReadings(slip.id);
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  send(res, 200, views.siteBillingDetailPage({
    user, slip, tariff, calc, basePath: '/municipal-billing', pdfBasePath: '/municipal-billing-pdf',
    pageTitle: 'Municipal statement', backLabel: 'Municipal Account Statements', hideCorrectionNote: true,
  }));
});

route('POST', '/municipal-billing/:id/delete', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!requireRole(req, res, user, auth.CAN_EDIT)) return;
  const slip = get('SELECT * FROM municipal_statement_slips WHERE id=?', [params.id]);
  if (slip) {
    run('DELETE FROM municipal_statement_readings WHERE slip_id=?', [params.id]);
    run('DELETE FROM municipal_statement_slips WHERE id=?', [params.id]);
    audit(user.userId, 'delete', 'municipal_statement_slip', slip.id, null, null, null, `Deleted municipal statement ${slip.label}`);
  }
  redirect(res, '/municipal-billing');
});

route('GET', '/municipal-billing-pdf/:id', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const slip = get('SELECT * FROM municipal_statement_slips WHERE id=?', [params.id]);
  if (!slip) return send(res, 404, 'Not found');
  const tariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
  const items = getMunicipalTariffItems(slip.tariff_id);
  const readings = getMunicipalStatementReadings(slip.id);
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  const monthlyTrend = monthlyTrendForMunicipal(slip.start_date);
  // Same-scale axis vs this property's own client billing PDF - see combinedAxisMax above.
  const siteTrendForAxis = monthlyTrendForSite(slip.start_date);
  const axisMaxOverrides = {
    cost: combinedAxisMax(monthlyTrend, siteTrendForAxis, ['elec', 'water', 'sanitation']),
    consumption: combinedAxisMax(monthlyTrend, siteTrendForAxis, ['elecKwh', 'waterM3']),
  };
  const propertyName = currentPropertyName(user);
  const pdfBuf = buildSiteBillingSlipPdf({
    propertyName, slip, tariff, calc, monthlyTrend, axisMaxOverrides, subtitle: 'Municipal Account Statement',
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });
  audit(user.userId, 'pdf_download', 'municipal_statement_slip', slip.id, null, null, null, slip.label);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-municipal-${slip.label}.pdf"` });
  res.end(pdfBuf);
});

// Combined PDF - every month's Municipal Account Statement summary page in one file (flat_site
// properties). Same reasoning/convention as /site-billing-pdf-all above.
route('GET', '/municipal-billing-pdf-all', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const slips = all('SELECT * FROM municipal_statement_slips ORDER BY start_date ASC');
  const propertyName = currentPropertyName(user);
  const entries = slips.map((slip) => {
    const tariff = get('SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
    const items = getMunicipalTariffItems(slip.tariff_id);
    const readings = getMunicipalStatementReadings(slip.id);
    const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
    return { propertyName, slip, tariff, calc, subtitle: 'Municipal Account Statement', generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  });
  const pdfBuf = buildSiteBillingSlipsCombinedPdf(entries);
  audit(user.userId, 'pdf_download', 'municipal_statement_slip', null, null, null, null, `combined:${entries.length} statements`);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-municipal-all.pdf"` });
  res.end(pdfBuf);
});

route('GET', '/billing', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const tenants = all('SELECT * FROM tenants ORDER BY name');
  const periods = all('SELECT * FROM billing_periods ORDER BY start_date DESC');
  send(res, 200, views.billingSelectorPage({ user, tenants, periods }));
});
route('GET', '/billing/select', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;
  if (!query.tenantId || !query.periodId) return redirect(res, '/billing');
  redirect(res, `/billing/${query.tenantId}/${query.periodId}`);
});

route('GET', '/billing/:tenantId/:periodId', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const tenant = get('SELECT * FROM tenants WHERE id=?', [params.tenantId]);
  const period = get('SELECT * FROM billing_periods WHERE id=?', [params.periodId]);
  if (!tenant || !period) return send(res, 404, 'Not found');
  let bill = get('SELECT * FROM bills WHERE tenant_id=? AND billing_period_id=?', [tenant.id, period.id]);
  if (!bill) {
    return send(res, 200, views.layout({
      title: 'No bill', user, active: '/billing',
      body: `<div class="bg-white border rounded p-6">No bill has been generated for <b>${views.esc(tenant.name)}</b> in <b>${views.esc(period.label)}</b> yet.</div>`,
    }));
  }
  const elecItems = all("SELECT * FROM bill_line_items WHERE bill_id=? AND utility_type='electricity' ORDER BY id", [bill.id]);
  const waterItems = all("SELECT * FROM bill_line_items WHERE bill_id=? AND utility_type='water' ORDER BY id", [bill.id]);
  const elecMeters = all(`SELECT DISTINCT m.serial, m.unit_scale, mr.start_reading, mr.end_reading FROM bill_line_items bli
    JOIN meters m ON m.id=bli.meter_id LEFT JOIN meter_readings mr ON mr.meter_id=m.id AND mr.billing_period_id=?
    WHERE bli.bill_id=? AND bli.utility_type='electricity'`, [period.id, bill.id]);
  const waterMeters = all(`SELECT DISTINCT m.serial, mr.start_reading, mr.end_reading FROM bill_line_items bli
    JOIN meters m ON m.id=bli.meter_id LEFT JOIN meter_readings mr ON mr.meter_id=m.id AND mr.billing_period_id=?
    WHERE bli.bill_id=? AND bli.utility_type='water'`, [period.id, bill.id]);
  const periods = all('SELECT * FROM billing_periods ORDER BY start_date');
  const idx = periods.findIndex(p => p.id === period.id);
  const prevPeriod = idx > 0 ? periods[idx - 1] : null;
  const nextPeriod = idx >= 0 && idx < periods.length - 1 ? periods[idx + 1] : null;
  const excelRef = all('SELECT * FROM excel_reference WHERE tenant_id=? AND billing_period_id=?', [tenant.id, period.id]);
  send(res, 200, views.billDetailPage({ user, tenant, period, bill, elecItems, waterItems, elecMeters, waterMeters, prevPeriod, nextPeriod, excelRef }));
});

route('GET', '/pdf/:billId', async (req, res, params) => {
  const user = requireLogin(req, res); if (!user) return;
  const bill = get('SELECT * FROM bills WHERE id=?', [params.billId]);
  if (!bill) return send(res, 404, 'Not found');
  const tenant = get('SELECT * FROM tenants WHERE id=?', [bill.tenant_id]);
  const period = get('SELECT * FROM billing_periods WHERE id=?', [bill.billing_period_id]);
  const elecItems = all("SELECT * FROM bill_line_items WHERE bill_id=? AND utility_type='electricity' ORDER BY id", [bill.id]);
  const waterItems = all("SELECT * FROM bill_line_items WHERE bill_id=? AND utility_type='water' ORDER BY id", [bill.id]);
  // Same meter-readings lookup the on-screen billing-slip page uses (billDetailPage's elecMeters/
  // waterMeters query, just above in this file) - added to the PDF 2026-08-24 so tenants can see
  // their own meter's start/end reading on the slip itself, not just a bare serial number.
  const elecMetersForPdf = all(`SELECT DISTINCT m.serial, m.unit_scale, mr.start_reading, mr.end_reading FROM bill_line_items bli
    JOIN meters m ON m.id=bli.meter_id LEFT JOIN meter_readings mr ON mr.meter_id=m.id AND mr.billing_period_id=?
    WHERE bli.bill_id=? AND bli.utility_type='electricity'`, [period.id, bill.id]);
  const waterMetersForPdf = all(`SELECT DISTINCT m.serial, mr.start_reading, mr.end_reading FROM bill_line_items bli
    JOIN meters m ON m.id=bli.meter_id LEFT JOIN meter_readings mr ON mr.meter_id=m.id AND mr.billing_period_id=?
    WHERE bli.bill_id=? AND bli.utility_type='water'`, [period.id, bill.id]);
  const monthlyTrend = monthlyTrendForTenant(tenant.id, period.start_date);
  const pdfBuf = buildBillingSlipPdf({
    tenantName: tenant.name, invoiceNumber: bill.invoice_number, unit: tenant.unit,
    periodLabel: period.label, accountNumber: tenant.account_number, startDate: period.start_date,
    endDate: period.end_date, dueDate: period.due_date, vatNumber: tenant.vat_number,
    elecConsumption: bill.electricity_consumption_kwh.toFixed(2), waterConsumption: bill.water_consumption_m3.toFixed(2),
    elecLineItems: elecItems, waterLineItems: waterItems, elecMeters: elecMetersForPdf, waterMeters: waterMetersForPdf,
    subtotal: bill.subtotal_excl_vat, vatRate: bill.vat_rate, vatAmount: bill.vat_amount, total: bill.total_incl_vat,
    status: bill.status, generatedAt: bill.generated_at, monthlyTrend, propertyName: currentPropertyName(user),
  });
  audit(user.userId, 'pdf_download', 'bill', bill.id, null, null, null, null);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${bill.invoice_number}.pdf"` });
  res.end(pdfBuf);
});

route('GET', '/solar-billing-slips', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;
  const allPeriods = all('SELECT * FROM billing_periods ORDER BY start_date DESC');
  const period = query.periodId ? get('SELECT * FROM billing_periods WHERE id=?', [query.periodId]) : latestPeriod();
  const slips = period ? solar.getSolarSlips(currentDb(), period.id) : [];
  send(res, 200, views.solarBillingSlipsPage({ user, period, allPeriods, slips }));
});

route('GET', '/municipal-accounts', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;
  const accounts = all('SELECT * FROM municipal_accounts ORDER BY label');
  if (!accounts.length) return send(res, 200, views.municipalAccountsPage({ user, accounts, account: null, statements: [], statement: null, comparison: null, isCombined: false }));

  if (query.accountId === 'all') {
    const labels = municipalCompare.allStatementLabels(currentDb());
    const statementFor = query.statementFor || (labels.length ? labels[0].statement_for : null);
    let statement = null, comparison = null, combinedInfo = null;
    if (statementFor) {
      combinedInfo = municipalCompare.buildCombinedStatement(currentDb(), statementFor);
      statement = combinedInfo.statement;
      comparison = municipalCompare.buildComparisonAll(currentDb(), statement);
    }
    const pdfUrl = statementFor ? `/municipal-pdf?accountId=all&statementFor=${encodeURIComponent(statementFor)}` : null;
    return send(res, 200, views.municipalAccountsPage({
      user, accounts, account: { id: 'all', label: 'All Accounts (Combined)' }, isCombined: true,
      statementLabels: labels, selectedStatementFor: statementFor, combinedInfo,
      statements: [], statement, comparison, pdfUrl,
    }));
  }

  const accountId = query.accountId ? Number(query.accountId) : accounts[0].id;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  const statements = all('SELECT * FROM municipal_statements WHERE municipal_account_id=? ORDER BY statement_date', [account.id]);
  const statementId = query.statementId ? Number(query.statementId) : (statements.length ? statements[statements.length - 1].id : null);
  const statement = statements.find((s) => s.id === statementId) || statements[statements.length - 1] || null;
  const comparison = statement ? municipalCompare.buildComparison(currentDb(), statement, account.label) : null;
  const pdfUrl = statement ? `/municipal-pdf?statementId=${statement.id}` : null;
  send(res, 200, views.municipalAccountsPage({ user, accounts, account, statements, statement, comparison, isCombined: false, pdfUrl }));
});

// Builds the flat data object buildMunicipalStatementPdf() expects from either a real
// municipal_statements row or the synthetic combined-statement object, plus whatever extra
// context (account label/number/address, trend series, missing-accounts note) that statement
// shape doesn't carry on its own.
function municipalPdfData(statement, accountLabel, accountNumber, address, monthlyTrend, combinedInfo, propertyName, municipalityName) {
  const s = statement;
  return {
    accountLabel, accountNumber, address, propertyName, municipalityName,
    statementFor: s.statement_for, invoiceNumber: s.invoice_number, statementDate: s.statement_date,
    tariffType: s.elec_tariff_type,
    elecReadingStart: s.elec_reading_start, elecReadingEnd: s.elec_reading_end,
    elecConsumptionKwh: s.elec_consumption_kwh, elecExclVat: s.elec_excl_vat, elecVat: s.elec_vat, elecInclVat: s.elec_incl_vat,
    elecLines: municipalCompare.electricityLineItems(s),
    waterReadingStart: s.water_reading_start, waterReadingEnd: s.water_reading_end, waterConsumptionKl: s.water_consumption_kl,
    waterExclVat: s.water_excl_vat, waterVat: s.water_vat, waterInclVat: s.water_incl_vat,
    sanitationExclVat: s.sanitation_excl_vat, sanitationVat: s.sanitation_vat, sanitationInclVat: s.sanitation_incl_vat,
    refuseExclVat: s.refuse_excl_vat, refuseVat: s.refuse_vat, refuseInclVat: s.refuse_incl_vat,
    sundryExclVat: s.sundry_excl_vat, sundryVat: s.sundry_vat, sundryInclVat: s.sundry_incl_vat,
    // Property Rates is still returned here (propertyRates* fields) in case something else ever
    // needs it, but it's deliberately left out of totalExclVat/totalVat/grandTotalInclVat - the
    // client asked for rates out of the "Total Charges" figure since it's a separate municipal
    // charge, not a utility. pdf.js and views.js no longer render a Property Rates line either.
    propertyRatesExclVat: s.property_rates_excl_vat, propertyRatesVat: s.property_rates_vat, propertyRatesInclVat: s.property_rates_incl_vat,
    totalExclVat: s.elec_excl_vat + s.water_excl_vat + s.sanitation_excl_vat + s.refuse_excl_vat + s.sundry_excl_vat,
    totalVat: s.elec_vat + s.water_vat + s.sanitation_vat + s.refuse_vat + s.sundry_vat,
    grandTotalInclVat: Math.round(((s.elec_incl_vat || 0) + (s.water_incl_vat || 0) + (s.sanitation_incl_vat || 0) + (s.refuse_incl_vat || 0) + (s.sundry_incl_vat || 0) + Number.EPSILON) * 100) / 100,
    monthlyTrend, matchedAccounts: combinedInfo ? combinedInfo.matchedAccounts : null, missingAccounts: combinedInfo ? combinedInfo.missingAccounts : null,
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  };
}

route('GET', '/municipal-pdf', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;

  if (query.accountId === 'all') {
    const statementFor = query.statementFor;
    if (!statementFor) return send(res, 404, 'Not found');
    const combinedInfo = municipalCompare.buildCombinedStatement(currentDb(), statementFor);
    const trend = municipalCompare.monthlyTrendAllAccounts(currentDb(), combinedInfo.statement.statement_date);
    const data = municipalPdfData(combinedInfo.statement, 'All Accounts (Combined)', '', `${currentPropertyName(user)} - all municipal accounts`, trend, combinedInfo, currentPropertyName(user), currentMunicipalityName(user));
    const pdfBuf = buildMunicipalStatementPdf(data);
    audit(user.userId, 'pdf_download', 'municipal_statement', null, null, null, null, `combined:${statementFor}`);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="municipal-combined-${statementFor.replace(/\s+/g, '-')}.pdf"` });
    return res.end(pdfBuf);
  }

  const statement = get('SELECT * FROM municipal_statements WHERE id=?', [Number(query.statementId)]);
  if (!statement) return send(res, 404, 'Not found');
  const account = get('SELECT * FROM municipal_accounts WHERE id=?', [statement.municipal_account_id]);
  const trend = municipalCompare.monthlyTrendForAccount(currentDb(), account.id, statement.statement_date);
  const data = municipalPdfData(statement, account.label, account.account_number, account.address, trend, null, currentPropertyName(user), currentMunicipalityName(user));
  const pdfBuf = buildMunicipalStatementPdf(data);
  audit(user.userId, 'pdf_download', 'municipal_statement', statement.id, null, null, null, null);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="municipal-${account.label.replace(/\s+/g, '-')}-${statement.statement_for.replace(/\s+/g, '-')}.pdf"` });
  res.end(pdfBuf);
});

// Combined PDF - every municipal account's every statement, one summary page each, no trend pages -
// tenant-model equivalent of /municipal-billing-pdf-all above (City Deep, Wingfield). Grouped by
// account (in the same order the account dropdown on /municipal-accounts uses - label ASC), then
// chronological within each account, so a printed stack reads as one account's full history before
// moving to the next - added 2026-08-11 so the client can print every account/month at once instead
// of stepping through the account+statement dropdowns one combination at a time.
route('GET', '/municipal-pdf-all', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const accounts = all('SELECT * FROM municipal_accounts ORDER BY label');
  const propertyName = currentPropertyName(user);
  const municipalityName = currentMunicipalityName(user);
  const entries = [];
  for (const account of accounts) {
    const statements = all('SELECT * FROM municipal_statements WHERE municipal_account_id=? ORDER BY statement_date ASC', [account.id]);
    for (const statement of statements) {
      entries.push(municipalPdfData(statement, account.label, account.account_number, account.address, null, null, propertyName, municipalityName));
    }
  }
  const pdfBuf = buildMunicipalStatementsCombinedPdf(entries);
  audit(user.userId, 'pdf_download', 'municipal_statement', null, null, null, null, `combined:${entries.length} statements, all accounts`);
  const fileSlug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileSlug}-municipal-all.pdf"` });
  res.end(pdfBuf);
});

route('GET', '/reconciliation', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const raw = all(`SELECT t.name tenant, bp.label period, er.utility_type,
      er.charge_total_excl_vat as excel_total,
      (SELECT SUM(bli.amount) FROM bill_line_items bli JOIN bills b ON b.id=bli.bill_id
        WHERE b.tenant_id=t.id AND b.billing_period_id=bp.id AND bli.utility_type=er.utility_type) as app_total
    FROM excel_reference er JOIN tenants t ON t.id=er.tenant_id JOIN billing_periods bp ON bp.id=er.billing_period_id
    ORDER BY t.name, bp.label, er.utility_type`);
  let exact = 0, close = 0, off = 0;
  const rows = raw.map(r => {
    const diff = (r.app_total || 0) - (r.excel_total || 0);
    const pct = r.excel_total ? Math.abs(diff / r.excel_total) * 100 : 0;
    if (Math.abs(diff) < 0.05) exact++; else if (pct < 1) close++; else off++;
    return { ...r, diff, pct };
  });
  send(res, 200, views.reconciliationPage({ user, rows, summary: { exact, close, off } }));
});

route('GET', '/audit-log', async (req, res) => {
  const user = requireLogin(req, res); if (!user) return;
  const entries = all(`SELECT al.*, u.username FROM audit_log al LEFT JOIN users u ON u.id=al.user_id ORDER BY al.id DESC LIMIT 200`);
  send(res, 200, views.auditLogPage({ user, entries }));
});

// ---------------- dispatcher ----------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
};

// Saves an uploaded meter-photo file (see readMultipartBody) under public/meter-photos/<property
// slug>/ - inside PUBLIC_DIR so tryServeStatic() below already knows how to serve it back out,
// with no extra route needed. Namespaced by property slug purely so City Deep's and Wingfield's
// photos don't land in the same folder; not a security boundary (nothing here is served
// selectively by login). Returns the web path to store in meter_readings.photo_path, or null if
// there's nothing usable to save (empty part, non-image content-type).
function saveMeterPhoto(propertySlug, meterId, periodId, file) {
  if (!file || !file.data || !file.data.length) return null;
  if (file.contentType && !file.contentType.startsWith('image/')) return null;
  const extMatch = /\.[a-zA-Z0-9]+$/.exec(file.filename || '');
  const ext = (extMatch ? extMatch[0] : '.jpg').toLowerCase();
  const dir = path.join(PUBLIC_DIR, 'meter-photos', propertySlug);
  fs.mkdirSync(dir, { recursive: true });
  const name = `meter-${meterId}-period-${periodId}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dir, name), file.data);
  return `/meter-photos/${propertySlug}/${name}`;
}

// Best-effort delete of a previously-saved meter photo (used when a manual reading is deleted).
// Never throws - a missing file (already cleaned up, or a path that turns out to be outside
// PUBLIC_DIR for any reason) just means there's nothing to remove.
function deleteMeterPhoto(webPath) {
  if (!webPath) return;
  const filePath = path.join(PUBLIC_DIR, webPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return;
  try { fs.unlinkSync(filePath); } catch (err) { /* already gone - fine */ }
}
function tryServeStatic(pathname, res) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
  res.end(fs.readFileSync(filePath));
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);
    if (req.method === 'GET' && tryServeStatic(pathname, res)) return;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      // Resolve which property's database this request should see BEFORE the handler runs, from
      // the session's currentProperty (set at login / by /switch-property) - anonymous requests
      // (login page, static assets) just get the default property's db, which they never
      // actually query. dbContext.run() keeps this pinned for the whole handler, including across
      // any `await`s inside it, without a shared mutable variable two concurrent requests could race.
      const sessionUser = auth.currentUser(req);
      const propDb = getPropertyDb((sessionUser && sessionUser.currentProperty) || DEFAULT_PROPERTY_SLUG);
      return await dbContext.run(propDb, () => r.handler(req, res, params, parsed.query));
    }
    send(res, 404, views.layout({ title: 'Not found', user: auth.currentUser(req), active: null, body: '<div class="bg-white border rounded p-6">404 - page not found.</div>' }));
  } catch (err) {
    console.error(err);
    send(res, 500, `<pre>${views.esc(err.stack)}</pre>`);
  }
});

server.listen(PORT, () => console.log(`HolmStone Utility Management Platform listening on http://localhost:${PORT} (properties: ${properties.map((p) => p.slug).join(', ')})`));
