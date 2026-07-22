// server.js - plain Node http server (no framework dependency - see README for why).
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const { open, migrate } = require('./db');
const auth = require('./auth');
const views = require('./views');
const { buildBillingSlipPdf } = require('./pdf');
const billing = require('./billing');
const solar = require('./solar');
const municipalCompare = require('./municipal_compare');

const db = open();
migrate(db);
const PORT = process.env.PORT || 8787;

// Auto-seed on first boot so a fresh deploy (e.g. a host with an ephemeral filesystem, or
// simply the first time this repo is cloned) works with nothing more than `node server.js` -
// no separate SSH/console step required.
const tenantCount = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
if (tenantCount === 0) {
  console.log('Empty database detected - running initial seed (March + April 2026 import)...');
  require('./seed').run();
  console.log('Initial seed complete.');
}
// Separate, self-contained pipeline (own de-dup key: invoice_number) - always safe to re-run, so
// just run it on every boot rather than gating on an empty-table check. Picks up any newly-added
// months in municipal_statements.json automatically on the next deploy.
require('./seed_municipal').run();

function get(sql, params = []) { return db.prepare(sql).get(...params); }
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

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
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category IN ('sanitation','sanitation_surcharge') THEN bli.amount END), 0) as sanitation
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
  const u = get('SELECT * FROM users WHERE username=?', [body.username || '']);
  if (!u || !auth.verifyPassword(body.password || '', u.salt, u.password_hash)) {
    return send(res, 401, views.loginPage('Invalid username or password.'));
  }
  const token = auth.createSession(u);
  auth.setSessionCookie(res, token);
  audit(u.id, 'login', 'user', u.id, null, null, null, null);
  redirect(res, '/dashboard');
});
route('GET', '/logout', async (req, res) => {
  const raw = auth.getCookie(req, 'sid');
  auth.clearSessionCookie(res);
  redirect(res, '/login');
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
  const body = await readBody(req);
  const assignments = all('SELECT meter_id FROM meter_assignments WHERE effective_to IS NULL');
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
    run(`INSERT INTO meter_readings (meter_id, billing_period_id, start_reading, end_reading, start_reading_kvarh, end_reading_kvarh, kva_reading, source, entered_by)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(meter_id, billing_period_id) DO UPDATE SET
           start_reading=excluded.start_reading, end_reading=excluded.end_reading,
           start_reading_kvarh=excluded.start_reading_kvarh, end_reading_kvarh=excluded.end_reading_kvarh,
           kva_reading=excluded.kva_reading, source=excluded.source, entered_by=excluded.entered_by`,
      [a.meter_id, period.id, startReading, Number(endVal), startKvarh, kvarhEnd ? Number(kvarhEnd) : null, kva ? Number(kva) : 0, 'manual', user.userId]);
    saved++;
  }
  const result = billing.generateBillsForPeriod(db, period.id);
  audit(user.userId, 'capture_readings', 'billing_period', period.id, null, null, `${saved} readings saved, ${result.billsCreated} bills generated`, null);
  send(res, 200, views.readingsResultPage({ user, period, result }));
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
    status: bill.status, generatedAt: bill.generated_at, monthlyTrend,
    notes: 'Reprinted from stored billing data - not from a live browser view.',
  });
  audit(user.userId, 'pdf_download', 'bill', bill.id, null, null, null, null);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${bill.invoice_number}.pdf"` });
  res.end(pdfBuf);
});

route('GET', '/solar-billing-slips', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;
  const allPeriods = all('SELECT * FROM billing_periods ORDER BY start_date DESC');
  const period = query.periodId ? get('SELECT * FROM billing_periods WHERE id=?', [query.periodId]) : latestPeriod();
  const slips = period ? solar.getSolarSlips(db, period.id) : [];
  send(res, 200, views.solarBillingSlipsPage({ user, period, allPeriods, slips }));
});

route('GET', '/municipal-accounts', async (req, res, params, query) => {
  const user = requireLogin(req, res); if (!user) return;
  const accounts = all('SELECT * FROM municipal_accounts ORDER BY label');
  if (!accounts.length) return send(res, 200, views.municipalAccountsPage({ user, accounts, account: null, statements: [], statement: null }));
  const accountId = query.accountId ? Number(query.accountId) : accounts[0].id;
  const account = accounts.find((a) => a.id === accountId) || accounts[0];
  const statements = all('SELECT * FROM municipal_statements WHERE municipal_account_id=? ORDER BY statement_date', [account.id]);
  const statementId = query.statementId ? Number(query.statementId) : (statements.length ? statements[statements.length - 1].id : null);
  const statement = statements.find((s) => s.id === statementId) || statements[statements.length - 1] || null;
  const comparison = statement ? municipalCompare.buildComparison(db, statement, account.label) : null;
  send(res, 200, views.municipalAccountsPage({ user, accounts, account, statements, statement, comparison }));
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
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
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
      return await r.handler(req, res, params, parsed.query);
    }
    send(res, 404, views.layout({ title: 'Not found', user: auth.currentUser(req), active: null, body: '<div class="bg-white border rounded p-6">404 - page not found.</div>' }));
  } catch (err) {
    console.error(err);
    send(res, 500, `<pre>${views.esc(err.stack)}</pre>`);
  }
});

server.listen(PORT, () => console.log(`City Deep Billing prototype listening on http://localhost:${PORT}`));
