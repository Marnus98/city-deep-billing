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
const { buildBillingSlipPdf, buildMunicipalStatementPdf } = require('./pdf');
const billing = require('./billing');
const solar = require('./solar');
const municipalCompare = require('./municipal_compare');
const properties = require('./properties');
const { seedUsers } = require('./shared_seed_users');

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
  const isEmpty = propDb.prepare('SELECT COUNT(*) c FROM tenants').get().c === 0;
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
  const monthlyTrend = monthlyTrendForTenant(tenant.id, period.start_date);
  const pdfBuf = buildBillingSlipPdf({
    tenantName: tenant.name, invoiceNumber: bill.invoice_number, unit: tenant.unit,
    periodLabel: period.label, accountNumber: tenant.account_number, startDate: period.start_date,
    endDate: period.end_date, dueDate: period.due_date, vatNumber: tenant.vat_number,
    elecConsumption: bill.electricity_consumption_kwh.toFixed(2), waterConsumption: bill.water_consumption_m3.toFixed(2),
    elecLineItems: elecItems, waterLineItems: waterItems,
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
