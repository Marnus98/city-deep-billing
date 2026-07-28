// views.js - server-rendered HTML. Plain template-literal functions (no templating engine
// dependency). Tailwind is loaded from the CDN by the *browser* viewing the page - that's
// independent of this sandbox's own package-registry access, so it's safe to rely on here.
const properties = require('./properties');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function money(n) {
  const v = Number(n || 0);
  const neg = v < 0;
  const [i, d] = Math.abs(v).toFixed(2).split('.');
  return (neg ? '-' : '') + 'R ' + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d;
}
function fmtNum(n, dp = 2) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); }

function layout({ title, user, active, body }) {
  const nav = [
    ['/dashboard', 'Dashboard'], ['/tenants', 'Tenants'], ['/meters', 'Meters'],
    ['/billing-periods', 'Billing Periods'], ['/billing', 'Billing'], ['/solar-billing-slips', 'Solar Billing Slips'],
    ['/municipal-accounts', 'Municipality'],
    ['/tariffs', 'Tariffs'], ['/reconciliation', 'Reconciliation'], ['/audit-log', 'Audit Log'],
  ];
  // Property switcher - auto-submits on change (same pattern as the Municipality Accounts page's
  // account selector). POSTs to /switch-property, which updates the session's currentProperty
  // (see auth.js/server.js) so every subsequent request resolves to that property's own database.
  // Sits to the left of the platform name in the sidebar header, per request.
  const propertySwitcher = user ? `
    <form method="post" action="/switch-property">
      <select name="property" onchange="this.form.submit()"
        class="bg-white text-slate-700 text-xs rounded px-2 py-1.5 border border-slate-300 cursor-pointer w-full">
        ${properties.map((p) => `<option value="${p.slug}" ${p.slug === user.currentProperty ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </form>` : '';
  // Left sidebar: logo + property switcher/platform name up top, the nav links running vertically
  // underneath (previously a horizontal bar along the top of every page), user info/logout pinned
  // to the bottom. Replaces the old top navbar entirely.
  const sidebar = user ? `
  <aside class="w-60 shrink-0 bg-white border-r border-slate-200 flex flex-col min-h-screen">
    <div class="p-4 border-b border-slate-200">
      <img src="/logo.png" alt="HolmStone" class="w-full h-auto mb-3"/>
      <div class="flex items-start gap-2">
        <div class="w-24 shrink-0">${propertySwitcher}</div>
        <div class="text-xs font-semibold text-slate-500 leading-tight pt-1.5">HolmStone Utility Management Platform</div>
      </div>
    </div>
    <nav class="flex-1 py-2 overflow-y-auto">
      ${nav.map(([href, label]) => `<a href="${href}" class="block px-4 py-2 text-sm ${active === href ? 'bg-slate-900 text-white font-semibold' : 'text-slate-600 hover:bg-slate-50'}">${label}</a>`).join('')}
    </nav>
    <div class="p-4 border-t border-slate-200 text-xs">
      <div class="text-slate-500 mb-2">${esc(user.fullName)} <span class="badge bg-slate-100 text-slate-600">${esc(user.role)}</span></div>
      <a href="/logout" class="text-blue-600 hover:underline">Log out</a>
    </div>
  </aside>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} - HolmStone Utility Management Platform</title>
<link rel="stylesheet" href="/style.css"/>
</head>
<body class="bg-slate-50 text-slate-800">
<div class="flex">
${sidebar}
<div class="flex-1 min-w-0">
  <div class="max-w-7xl mx-auto px-4 py-6">
  ${body}
  </div>
</div>
</div>
</body>
</html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Sign in - HolmStone Utility Management Platform</title>
  <link rel="stylesheet" href="/style.css"/></head>
  <body class="bg-slate-100 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-xl shadow p-8 w-full max-w-sm">
    <img src="/logo.png" alt="HolmStone" class="w-40 h-auto mx-auto mb-4"/>
    <h1 class="text-lg font-bold mb-1 text-center">Utility Management Platform</h1>
    <p class="text-sm text-slate-500 mb-6 text-center">Sign in to continue</p>
    ${error ? `<div class="bg-red-50 text-red-700 text-sm rounded p-2 mb-4">${esc(error)}</div>` : ''}
    <form method="post" action="/login" class="space-y-3">
      <div><label class="text-sm font-medium">Username</label>
        <input name="username" class="w-full border rounded px-3 py-2 mt-1" autofocus/></div>
      <div><label class="text-sm font-medium">Password</label>
        <input name="password" type="password" class="w-full border rounded px-3 py-2 mt-1"/></div>
      <button class="w-full bg-slate-900 text-white rounded py-2 font-medium">Sign in</button>
    </form>
    <div class="text-xs text-slate-400 mt-5 leading-relaxed">
      Demo accounts (seeded by <code>node seed.js</code>):<br/>
      admin/admin123 &middot; billing/billing123 &middot; reviewer/reviewer123 &middot; viewer/viewer123
    </div>
  </div></body></html>`;
}

function statCard(label, value, sub) {
  return `<div class="bg-white rounded-lg border p-4">
    <div class="text-xs uppercase tracking-wide text-slate-500">${esc(label)}</div>
    <div class="text-2xl font-bold mt-1">${value}</div>
    ${sub ? `<div class="text-xs text-slate-400 mt-1">${sub}</div>` : ''}
  </div>`;
}

function dashboardPage({ user, stats, recentBills, missing, currentPeriod, allPeriods }) {
  const body = `
  <div class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-bold">Dashboard</h1>
    <form method="get" action="/dashboard" class="flex items-center gap-2">
      <label class="text-sm text-slate-500">Billing month:</label>
      <select name="periodId" class="border rounded px-3 py-2 text-sm">
        ${(allPeriods || []).map(p => `<option value="${p.id}" ${currentPeriod && p.id === currentPeriod.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select>
      <button class="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium">View</button>
    </form>
  </div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
    ${statCard('Active tenants', stats.activeTenants)}
    ${statCard('Tenants billed this month', stats.billedThisMonth)}
    ${statCard('Missing readings', stats.missingCount, missing.length ? 'See list below' : 'None outstanding')}
    ${statCard('Draft bills', stats.draftBills)}
    ${statCard('Finalised bills', stats.finalisedBills)}
    ${statCard('Total electricity billed', money(stats.totalElecBilled))}
    ${statCard('Total water & sewer billed', money(stats.totalWaterBilled))}
    ${statCard('Total amount billed (incl. VAT)', money(stats.totalBilled))}
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
    ${statCard('Total electricity consumption', fmtNum(stats.totalElecKwh, 0) + ' kWh')}
    ${statCard('Total water consumption', fmtNum(stats.totalWaterKl, 0) + ' kL')}
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
    <div class="bg-white rounded-lg border">
      <div class="px-4 py-3 border-b font-semibold">Recently generated billing slips</div>
      <table class="w-full text-sm">
        <tbody>
        ${recentBills.map(b => `<tr class="border-b last:border-0">
          <td class="px-4 py-2">${esc(b.tenant)}</td>
          <td class="px-4 py-2 text-slate-500">${esc(b.period)}</td>
          <td class="px-4 py-2 text-right">${money(b.total_incl_vat)}</td>
          <td class="px-4 py-2 text-right"><a class="text-blue-600 hover:underline" href="/billing/${b.tenant_id}/${b.billing_period_id}">View</a></td>
        </tr>`).join('') || '<tr><td class="px-4 py-3 text-slate-400">No bills yet</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="bg-white rounded-lg border">
      <div class="px-4 py-3 border-b font-semibold">Tenants missing readings this month</div>
      <table class="w-full text-sm">
        <tbody>
        ${missing.map(m => `<tr class="border-b last:border-0"><td class="px-4 py-2">${esc(m)}</td></tr>`).join('') || '<tr><td class="px-4 py-3 text-slate-400">All tenants have readings captured</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>`;
  return layout({ title: 'Dashboard', user, active: '/dashboard', body });
}

function tenantsPage({ user, tenants }) {
  const body = `
  <div class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-bold">Tenants</h1>
    <span class="text-sm text-slate-500">${tenants.length} tenants</span>
  </div>
  <div class="bg-white rounded-lg border overflow-hidden">
    <table class="w-full text-sm dt">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Name</th><th class="px-4 py-2">Site</th><th class="px-4 py-2">Unit</th>
        <th class="px-4 py-2">Status</th><th class="px-4 py-2">Meters</th><th class="px-4 py-2"></th>
      </tr></thead>
      <tbody>
        ${tenants.map(t => `<tr class="border-b last:border-0 hover:bg-slate-50">
          <td class="px-4 py-2 font-medium">${esc(t.name)}</td>
          <td class="px-4 py-2 text-slate-500">${esc(t.site_name || '-')}</td>
          <td class="px-4 py-2 text-slate-500">${esc(t.unit || '-')}</td>
          <td class="px-4 py-2"><span class="badge ${t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}">${esc(t.status)}</span></td>
          <td class="px-4 py-2 text-slate-500">${t.meter_count}</td>
          <td class="px-4 py-2 text-right"><a class="text-blue-600 hover:underline" href="/tenants/${t.id}">View</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
  return layout({ title: 'Tenants', user, active: '/tenants', body });
}

function tenantDetailPage({ user, tenant, meters, bills }) {
  const body = `
  <a href="/tenants" class="text-sm text-blue-600 hover:underline">&larr; Back to tenants</a>
  <div class="flex items-start justify-between mt-2 mb-6">
    <div>
      <h1 class="text-2xl font-bold">${esc(tenant.name)}</h1>
      <p class="text-slate-500 text-sm mt-1">${esc(tenant.site_name || '')} ${tenant.unit ? '&middot; Unit ' + esc(tenant.unit) : ''}</p>
    </div>
    <span class="badge ${tenant.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}">${esc(tenant.status)}</span>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
    <div class="bg-white rounded-lg border p-4 md:col-span-1">
      <div class="font-semibold mb-2">Tenant details</div>
      <dl class="text-sm space-y-1">
        <div class="flex justify-between"><dt class="text-slate-500">Account No.</dt><dd>${esc(tenant.account_number || '-')}</dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">Email</dt><dd>${esc(tenant.email || '-')}</dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">Phone</dt><dd>${esc(tenant.phone || '-')}</dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">VAT No.</dt><dd>${esc(tenant.vat_number || '-')}</dd></div>
        <div class="flex justify-between"><dt class="text-slate-500">Opening balance</dt><dd>${money(tenant.opening_balance)}</dd></div>
      </dl>
    </div>
    <div class="bg-white rounded-lg border p-4 md:col-span-2">
      <div class="font-semibold mb-2">Assigned meters</div>
      <table class="w-full text-sm">
        <thead><tr class="text-left text-slate-500"><th class="py-1">Serial</th><th>Utility</th><th>Role</th><th>Tariff code</th><th>Allocation %</th></tr></thead>
        <tbody>
        ${meters.map(m => `<tr class="border-t"><td class="py-1">${esc(m.serial)}</td><td>${esc(m.utility_type)}</td><td>${esc(m.role)}</td><td>${m.tariff_code ?? '-'}</td><td>${(m.allocation_pct * 100).toFixed(1)}%</td></tr>`).join('') || '<tr><td class="py-2 text-slate-400" colspan="5">No meters assigned</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
  <div class="bg-white rounded-lg border">
    <div class="px-4 py-3 border-b font-semibold">Billing history</div>
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Period</th><th class="px-4 py-2">Status</th><th class="px-4 py-2 text-right">Elec kWh</th>
        <th class="px-4 py-2 text-right">Water m&sup3;</th><th class="px-4 py-2 text-right">Total (incl. VAT)</th><th class="px-4 py-2"></th>
      </tr></thead>
      <tbody>
      ${bills.map(b => `<tr class="border-b last:border-0 hover:bg-slate-50">
        <td class="px-4 py-2 font-medium">${esc(b.label)}</td>
        <td class="px-4 py-2"><span class="badge ${statusColor(b.status)}">${esc(b.status)}</span></td>
        <td class="px-4 py-2 text-right">${fmtNum(b.electricity_consumption_kwh, 1)}</td>
        <td class="px-4 py-2 text-right">${fmtNum(b.water_consumption_m3, 1)}</td>
        <td class="px-4 py-2 text-right font-medium">${money(b.total_incl_vat)}</td>
        <td class="px-4 py-2 text-right"><a class="text-blue-600 hover:underline" href="/billing/${tenant.id}/${b.billing_period_id}">View bill</a></td>
      </tr>`).join('') || '<tr><td class="px-4 py-3 text-slate-400" colspan="6">No billing history yet</td></tr>'}
      </tbody>
    </table>
  </div>`;
  return layout({ title: tenant.name, user, active: '/tenants', body });
}

function statusColor(s) {
  return { draft: 'bg-amber-100 text-amber-700', reviewed: 'bg-blue-100 text-blue-700', finalised: 'bg-green-100 text-green-700', issued: 'bg-emerald-100 text-emerald-700', cancelled: 'bg-red-100 text-red-700' }[s] || 'bg-slate-100 text-slate-600';
}

function metersPage({ user, meters }) {
  const body = `
  <h1 class="text-2xl font-bold mb-4">Meters</h1>
  <div class="bg-white rounded-lg border overflow-hidden">
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Serial</th><th class="px-4 py-2">Utility</th><th class="px-4 py-2">Role</th>
        <th class="px-4 py-2">Location</th><th class="px-4 py-2">Make</th><th class="px-4 py-2">Reading type</th>
      </tr></thead>
      <tbody>
      ${meters.map(m => `<tr class="border-b last:border-0">
        <td class="px-4 py-2 font-mono">${esc(m.serial)}</td>
        <td class="px-4 py-2">${esc(m.utility_type)}</td>
        <td class="px-4 py-2"><span class="badge ${m.role === 'tenant' ? 'bg-blue-100 text-blue-700' : 'bg-slate-200 text-slate-600'}">${esc(m.role)}</span></td>
        <td class="px-4 py-2 text-slate-500">${esc(m.location || '-')}</td>
        <td class="px-4 py-2 text-slate-500">${esc(m.make || '-')}</td>
        <td class="px-4 py-2 text-slate-500">${esc(m.reading_type || '-')}</td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
  return layout({ title: 'Meters', user, active: '/meters', body });
}

function tariffsPage({ user, tariffs }) {
  const body = `
  <h1 class="text-2xl font-bold mb-4">Tariffs</h1>
  <div class="space-y-6">
  ${tariffs.map(t => `
    <div class="bg-white rounded-lg border">
      <div class="px-4 py-3 border-b font-semibold flex justify-between">
        <span>${esc(t.name)} <span class="text-xs text-slate-400">(${esc(t.utility_type)}${t.code ? ', code ' + t.code : ''})</span></span>
      </div>
      <div class="px-4 py-3 space-y-3">
      ${t.versions.map(v => `
        <div class="border rounded p-3">
          <div class="text-xs text-slate-500 mb-2">Effective ${esc(v.effective_from)} ${v.effective_to ? 'to ' + esc(v.effective_to) : '(current)'} &middot; VAT ${(v.vat_rate * 100).toFixed(0)}%</div>
          <pre class="text-xs bg-slate-50 rounded p-2 overflow-x-auto">${esc(JSON.stringify(JSON.parse(v.params_json), null, 1))}</pre>
        </div>`).join('')}
      </div>
    </div>`).join('')}
  </div>`;
  return layout({ title: 'Tariffs', user, active: '/tariffs', body });
}

function billingPeriodsPage({ user, periods }) {
  const body = `
  <div class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-bold">Billing Periods</h1>
    <a href="/billing-periods/new" class="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium">+ New billing period</a>
  </div>
  <div class="bg-white rounded-lg border overflow-hidden">
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Label</th><th class="px-4 py-2">Start</th><th class="px-4 py-2">End</th>
        <th class="px-4 py-2">Due date</th><th class="px-4 py-2 text-right">Bills</th><th class="px-4 py-2"></th>
      </tr></thead>
      <tbody>
      ${periods.map(p => `<tr class="border-b last:border-0">
        <td class="px-4 py-2 font-medium">${esc(p.label)}</td>
        <td class="px-4 py-2">${esc(p.start_date)}</td>
        <td class="px-4 py-2">${esc(p.end_date)}</td>
        <td class="px-4 py-2">${esc(p.due_date || '-')}</td>
        <td class="px-4 py-2 text-right">${p.bill_count}</td>
        <td class="px-4 py-2 text-right"><a class="text-blue-600 hover:underline" href="/readings/${p.id}">Capture readings</a></td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
  return layout({ title: 'Billing Periods', user, active: '/billing-periods', body });
}

function newBillingPeriodPage({ user, error }) {
  const body = `
  <a href="/billing-periods" class="text-sm text-blue-600 hover:underline">&larr; Billing periods</a>
  <h1 class="text-2xl font-bold mt-2 mb-4">New billing period</h1>
  ${error ? `<div class="bg-red-50 text-red-700 text-sm rounded p-2 mb-4 max-w-lg">${esc(error)}</div>` : ''}
  <div class="bg-white rounded-lg border p-6 max-w-lg">
    <form method="post" action="/billing-periods" class="space-y-4">
      <div><label class="text-sm font-medium">Label</label>
        <input name="label" placeholder="2026-07" class="w-full border rounded px-3 py-2 mt-1" required/></div>
      <div><label class="text-sm font-medium">Start date</label>
        <input name="start_date" type="date" class="w-full border rounded px-3 py-2 mt-1" required/></div>
      <div><label class="text-sm font-medium">End date</label>
        <input name="end_date" type="date" class="w-full border rounded px-3 py-2 mt-1" required/></div>
      <div><label class="text-sm font-medium">Invoice date</label>
        <input name="invoice_date" type="date" class="w-full border rounded px-3 py-2 mt-1"/></div>
      <div><label class="text-sm font-medium">Due date</label>
        <input name="due_date" type="date" class="w-full border rounded px-3 py-2 mt-1"/></div>
      <button class="bg-slate-900 text-white rounded px-4 py-2 font-medium">Create &amp; capture readings</button>
    </form>
  </div>`;
  return layout({ title: 'New billing period', user, active: '/billing-periods', body });
}

function readingsCapturePage({ user, period, groups }) {
  const rowsHtml = groups.map(g => `
    <div class="bg-white rounded-lg border mb-4">
      <div class="px-4 py-2 border-b font-semibold">${esc(g.tenant.name)}</div>
      <table class="w-full text-sm">
        <thead><tr class="text-left text-slate-500 bg-slate-50">
          <th class="px-4 py-1">Serial</th><th class="px-4 py-1">Utility</th>
          <th class="px-4 py-1">Start reading</th><th class="px-4 py-1">End reading</th>
          <th class="px-4 py-1">Multiplier</th>
          <th class="px-4 py-1">kVA (demand)</th><th class="px-4 py-1">kVArh end</th>
        </tr></thead>
        <tbody>
        ${g.meters.map(m => `<tr class="border-t">
          <td class="px-4 py-1 font-mono">${esc(m.serial)}</td>
          <td class="px-4 py-1">${esc(m.utility_type)}</td>
          <td class="px-4 py-1"><input name="start_${m.meter_id}" type="number" step="0.01" value="${m.priorEnd ?? ''}" class="border rounded px-2 py-1 w-28"/></td>
          <td class="px-4 py-1"><input name="end_${m.meter_id}" type="number" step="0.01" class="border rounded px-2 py-1 w-28"/></td>
          <td class="px-4 py-1">${m.unitScale && m.unitScale !== 1 ? `<span class="badge bg-amber-100 text-amber-700">&times;${m.unitScale}</span>` : '<span class="text-slate-300">&mdash;</span>'}</td>
          <td class="px-4 py-1">${m.showDemand ? `<input name="kva_${m.meter_id}" type="number" step="0.01" class="border rounded px-2 py-1 w-24"/>` : '<span class="text-slate-300">&mdash;</span>'}</td>
          <td class="px-4 py-1">${m.showDemand ? `<input name="kvarh_end_${m.meter_id}" type="number" step="0.01" value="${m.priorEndKvarh ?? ''}" class="border rounded px-2 py-1 w-24"/>` : '<span class="text-slate-300">&mdash;</span>'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`).join('');

  const body = `
  <a href="/billing-periods" class="text-sm text-blue-600 hover:underline">&larr; Billing periods</a>
  <h1 class="text-2xl font-bold mt-2 mb-1">Capture readings &mdash; ${esc(period.label)}</h1>
  <p class="text-sm text-slate-500 mb-4">Enter each meter's closing reading exactly as it appears on the meter dial. Start readings are pre-filled from the last recorded reading &mdash; double-check any meter that was replaced. Leave a row blank to skip that meter for now; a tenant's bill won't be (re)generated until every one of their meters has a reading for this period. Meters flagged with a <span class="badge bg-amber-100 text-amber-700">&times;N</span> multiplier read a fraction of true consumption off the dial (CT ratio) &mdash; enter the raw dial numbers as-is, the app applies the multiplier automatically.</p>
  <form method="post" action="/readings/${period.id}">
    ${rowsHtml || '<div class="bg-white border rounded p-6 text-slate-400">No active meter assignments found.</div>'}
    <button class="bg-slate-900 text-white rounded px-6 py-2 font-medium mt-2">Save readings &amp; generate bills</button>
  </form>`;
  return layout({ title: `Capture readings - ${period.label}`, user, active: '/billing-periods', body });
}

function readingsResultPage({ user, period, result }) {
  const body = `
  <a href="/billing-periods" class="text-sm text-blue-600 hover:underline">&larr; Billing periods</a>
  <h1 class="text-2xl font-bold mt-2 mb-4">Readings saved &mdash; ${esc(period.label)}</h1>
  <div class="bg-white rounded-lg border p-6 max-w-xl mb-4">
    <div class="text-lg font-semibold text-green-700 mb-1">${result.billsCreated} bill${result.billsCreated === 1 ? '' : 's'} generated</div>
    <a href="/billing-periods" class="text-sm text-blue-600 hover:underline">Back to billing periods &rarr;</a>
  </div>
  ${result.missing.length ? `
  <div class="bg-white rounded-lg border p-4 max-w-xl">
    <div class="font-semibold text-amber-700 mb-2">${result.missing.length} meter reading${result.missing.length === 1 ? '' : 's'} still missing</div>
    <table class="w-full text-sm">
      <thead><tr class="text-left text-slate-500"><th>Tenant</th><th>Meter</th><th>Utility</th></tr></thead>
      <tbody>${result.missing.map(m => `<tr class="border-t"><td class="py-1">${esc(m.tenant)}</td><td class="py-1 font-mono">${esc(m.serial)}</td><td class="py-1">${esc(m.utility_type)}</td></tr>`).join('')}</tbody>
    </table>
    <a href="/readings/${period.id}" class="text-sm text-blue-600 hover:underline mt-3 inline-block">Go back and fill these in &rarr;</a>
  </div>` : ''}`;
  return layout({ title: `Readings saved - ${period.label}`, user, active: '/billing-periods', body });
}

function billingSelectorPage({ user, tenants, periods }) {
  const body = `
  <h1 class="text-2xl font-bold mb-4">Billing</h1>
  <div class="bg-white rounded-lg border p-6 max-w-lg">
    <form method="get" action="/billing/select" class="space-y-4">
      <div>
        <label class="text-sm font-medium">Tenant</label>
        <select name="tenantId" class="w-full border rounded px-3 py-2 mt-1">
          ${tenants.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="text-sm font-medium">Billing month</label>
        <select name="periodId" class="w-full border rounded px-3 py-2 mt-1">
          ${periods.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}
        </select>
      </div>
      <button class="bg-slate-900 text-white rounded px-4 py-2 font-medium">View bill</button>
    </form>
  </div>`;
  return layout({ title: 'Billing', user, active: '/billing', body });
}

function billDetailPage({ user, tenant, period, bill, elecItems, waterItems, elecMeters, waterMeters, prevPeriod, nextPeriod, excelRef, canFinalise }) {
  const lineTable = (title, items, meters, consumption, unitLabel) => `
  <div class="bg-white rounded-lg border">
    <div class="px-4 py-3 border-b font-semibold flex justify-between">
      <span>${title}</span><span class="text-slate-500 text-sm font-normal">${fmtNum(consumption, 2)} ${unitLabel}</span>
    </div>
    <div class="px-4 py-3">
      <div class="text-xs uppercase text-slate-400 mb-1">Meter readings</div>
      <table class="w-full text-xs mb-3">
        <thead><tr class="text-left text-slate-500"><th class="py-1">Serial</th><th>Start</th><th>End</th><th>Consumption</th></tr></thead>
        <tbody>${meters.map(m => {
          const scale = m.unit_scale || 1;
          const consumption = (m.end_reading - m.start_reading) * scale;
          return `<tr class="border-t"><td class="py-1 font-mono">${esc(m.serial)}</td><td>${fmtNum(m.start_reading, 2)}</td><td>${fmtNum(m.end_reading, 2)}</td><td>${fmtNum(consumption, 2)}${scale !== 1 ? ` <span class="text-slate-400">(&times;${scale})</span>` : ''}</td></tr>`;
        }).join('') || '<tr><td class="py-1 text-slate-400" colspan="4">No meter readings</td></tr>'}</tbody>
      </table>
      <div class="text-xs uppercase text-slate-400 mb-1">Charge breakdown</div>
      <table class="w-full text-sm">
        <tbody>
        ${items.map(i => `<tr class="border-t"><td class="py-1">${esc(i.description)}${i.quantity != null ? ` <span class="text-slate-400">(${fmtNum(i.quantity, 2)})</span>` : ''}</td><td class="py-1 text-right">${money(i.amount)}</td></tr>`).join('') || '<tr><td class="py-2 text-slate-400" colspan="2">No charges</td></tr>'}
        <tr class="border-t font-semibold"><td class="py-1">Subtotal</td><td class="py-1 text-right">${money(items.reduce((s, i) => s + i.amount, 0))}</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;

  const recon = excelRef ? `
  <div class="bg-white rounded-lg border p-4 mb-6">
    <div class="font-semibold mb-2">Reconciliation vs. source workbook</div>
    <table class="w-full text-sm">
      <thead><tr class="text-left text-slate-500"><th>Utility</th><th class="text-right">Excel total (excl. VAT)</th><th class="text-right">App total (excl. VAT)</th><th class="text-right">Variance</th></tr></thead>
      <tbody>
      ${excelRef.map(r => {
        const appTotal = r.utility_type === 'electricity' ? elecItems.reduce((s, i) => s + i.amount, 0) : waterItems.reduce((s, i) => s + i.amount, 0);
        const diff = appTotal - r.charge_total_excl_vat;
        return `<tr class="border-t"><td class="py-1 capitalize">${esc(r.utility_type)}</td><td class="text-right">${money(r.charge_total_excl_vat)}</td><td class="text-right">${money(appTotal)}</td><td class="text-right ${Math.abs(diff) < 0.05 ? 'text-green-600' : 'text-amber-600'}">${money(diff)}</td></tr>`;
      }).join('')}
      </tbody>
    </table>
  </div>` : '';

  const body = `
  <div class="flex items-center justify-between mb-1">
    <div>
      <a href="/tenants/${tenant.id}" class="text-sm text-blue-600 hover:underline">&larr; ${esc(tenant.name)}</a>
      <h1 class="text-2xl font-bold mt-1">Billing slip &mdash; ${esc(period.label)}</h1>
    </div>
    <div class="flex items-center gap-3">
      <span class="badge ${statusColor(bill.status)}">${esc(bill.status)}</span>
      <a href="/pdf/${bill.id}" class="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium">Download PDF</a>
    </div>
  </div>
  <div class="flex gap-4 text-sm mb-6">
    ${prevPeriod ? `<a class="text-blue-600 hover:underline" href="/billing/${tenant.id}/${prevPeriod.id}">&larr; ${esc(prevPeriod.label)}</a>` : '<span class="text-slate-300">&larr; earlier</span>'}
    ${nextPeriod ? `<a class="text-blue-600 hover:underline" href="/billing/${tenant.id}/${nextPeriod.id}">${esc(nextPeriod.label)} &rarr;</a>` : '<span class="text-slate-300">later &rarr;</span>'}
  </div>
  ${recon}
  <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
    ${lineTable('Electricity', elecItems, elecMeters, bill.electricity_consumption_kwh, 'kWh')}
    ${lineTable('Water &amp; Sanitation', waterItems, waterMeters, bill.water_consumption_m3, 'm&sup3;')}
  </div>
  <div class="bg-white rounded-lg border p-4 max-w-md ml-auto">
    <div class="flex justify-between py-1"><span>Subtotal (excl. VAT)</span><span>${money(bill.subtotal_excl_vat)}</span></div>
    <div class="flex justify-between py-1"><span>VAT (${(bill.vat_rate * 100).toFixed(0)}%)</span><span>${money(bill.vat_amount)}</span></div>
    <div class="flex justify-between py-2 border-t font-bold text-lg mt-1"><span>Total payable</span><span>${money(bill.total_incl_vat)}</span></div>
  </div>`;
  return layout({ title: `${tenant.name} - ${period.label}`, user, active: '/billing', body });
}

function solarBillingSlipsPage({ user, period, allPeriods, slips }) {
  const kwh = (n) => fmtNum(n, 1) + ' kWh';

  const rowHtml = (r) => `<tr class="border-t ${r.bold ? 'font-semibold bg-slate-50' : ''}">
    <td class="py-1 pl-2">${esc(r.label)}${r.serial ? ` <span class="text-slate-400 font-mono text-xs">(${esc(r.serial)})</span>` : ''}</td>
    <td class="py-1 text-right ${r.kwh < 0 ? 'text-red-600' : ''}">${kwh(r.kwh)}</td>
    <td class="py-1 text-right ${r.rand < 0 ? 'text-red-600' : ''}">${money(r.rand)}</td>
  </tr>`;

  const sectionHtml = (s) => `
    <div class="text-xs uppercase tracking-wide text-slate-500 mt-3 mb-1">${esc(s.heading)}</div>
    <table class="w-full text-sm">
      <tbody>${s.rows.map(rowHtml).join('')}</tbody>
    </table>`;

  const slipHtml = (slip) => `
  <div class="bg-white rounded-lg border mb-6">
    <div class="px-4 py-3 border-b font-semibold flex justify-between items-baseline">
      <span>${esc(slip.title)}</span>
      <span class="text-slate-500 text-sm font-normal">Total Due: ${kwh(slip.total.due.kwh)} &middot; ${money(slip.total.due.rand)}</span>
    </div>
    <div class="px-4 py-2">
      ${slip.sections.map(sectionHtml).join('')}
      <div class="mt-3 pt-3 border-t">
        <table class="w-full text-sm">
          <tbody>
            <tr class="border-t"><td class="py-1 pl-2 font-medium">Tenant Munic Usage (total)</td><td class="py-1 text-right">${kwh(slip.total.muniUsage.kwh)}</td><td class="py-1 text-right">${money(slip.total.muniUsage.rand)}</td></tr>
            <tr class="border-t"><td class="py-1 pl-2 font-medium">Solar Used (total)</td><td class="py-1 text-right">${kwh(slip.total.solarUsed.kwh)}</td><td class="py-1 text-right">${money(slip.total.solarUsed.rand)}</td></tr>
            <tr class="border-t font-semibold bg-slate-50"><td class="py-1 pl-2">Total Due</td><td class="py-1 text-right">${kwh(slip.total.due.kwh)}</td><td class="py-1 text-right">${money(slip.total.due.rand)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  const parkTotal = slips.reduce((s, sl) => ({ kwh: s.kwh + sl.total.due.kwh, rand: s.rand + sl.total.due.rand }), { kwh: 0, rand: 0 });
  const parkSolar = slips.reduce((s, sl) => ({ kwh: s.kwh + sl.total.solarUsed.kwh, rand: s.rand + sl.total.solarUsed.rand }), { kwh: 0, rand: 0 });

  const body = `
  <div class="flex items-center justify-between mb-1">
    <h1 class="text-2xl font-bold">Solar Billing Slips</h1>
    <form method="get" action="/solar-billing-slips" class="flex items-center gap-2">
      <label class="text-sm text-slate-500">Billing month:</label>
      <select name="periodId" class="border rounded px-3 py-2 text-sm">
        ${(allPeriods || []).map((p) => `<option value="${p.id}" ${period && p.id === period.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
      </select>
      <button class="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium">View</button>
    </form>
  </div>
  <p class="text-sm text-slate-500 mb-4">Breaks down each solar-connected tenant's already-billed electricity energy charge by source &mdash; municipal grid vs. the on-site solar installation. This is a reporting view only; it does not change any tenant's invoiced amount (every figure below is reconstructed from that tenant's actual bill).</p>
  ${!slips.length ? `<div class="bg-white border rounded p-6 text-slate-400">No billing data for this period yet.</div>` : `
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6 max-w-2xl">
    ${statCard('Park-wide total (7 solar tenants)', money(parkTotal.rand), fmtNum(parkTotal.kwh, 0) + ' kWh')}
    ${statCard('Of which solar-sourced', money(parkSolar.rand), fmtNum(parkSolar.kwh, 0) + ' kWh &middot; ' + (parkTotal.rand ? ((parkSolar.rand / parkTotal.rand) * 100).toFixed(1) : '0') + '% of total')}
  </div>
  ${slips.map(slipHtml).join('')}`}`;
  return layout({ title: 'Solar Billing Slips', user, active: '/solar-billing-slips', body });
}

function municipalAccountsPage({ user, accounts, account, statements, statement, comparison, isCombined, statementLabels, selectedStatementFor, combinedInfo, pdfUrl }) {
  if (!accounts.length) {
    return layout({ title: 'Municipality', user, active: '/municipal-accounts', body: `
      <h1 class="text-2xl font-bold mb-4">Municipality</h1>
      <div class="bg-white border rounded p-6 text-slate-400">No municipal statements imported yet.</div>` });
  }

  const catRow = (label, consumption, unit, exclVat, vat, inclVat, opts = {}) => `
    <tr class="border-t ${opts.total ? 'font-semibold bg-slate-50' : ''} ${opts.sub ? 'text-slate-500' : ''}">
      <td class="py-1.5 ${opts.sub ? 'pl-6 text-sm' : 'pl-2'}">${esc(label)}</td>
      <td class="py-1.5 text-right">${consumption != null ? fmtNum(consumption, 1) + (unit ? ' ' + unit : '') : '&mdash;'}</td>
      <td class="py-1.5 text-right">${money(exclVat)}</td>
      <td class="py-1.5 text-right">${money(vat)}</td>
      <td class="py-1.5 text-right">${money(inclVat)}</td>
    </tr>`;
  // Raw label text only (no markup) - used where esc() must not double-escape an already-built
  // HTML fragment like a trailing <span>.
  const catRowHtml = (labelHtml, consumption, unit, exclVat, vat, inclVat, opts = {}) => `
    <tr class="border-t ${opts.total ? 'font-semibold bg-slate-50' : ''} ${opts.sub ? 'text-slate-500' : ''}">
      <td class="py-1.5 ${opts.sub ? 'pl-6 text-sm' : 'pl-2'}">${labelHtml}</td>
      <td class="py-1.5 text-right">${consumption != null ? fmtNum(consumption, 1) + (unit ? ' ' + unit : '') : '&mdash;'}</td>
      <td class="py-1.5 text-right">${money(exclVat)}</td>
      <td class="py-1.5 text-right">${money(vat)}</td>
      <td class="py-1.5 text-right">${money(inclVat)}</td>
    </tr>`;

  let breakdownHtml = `<div class="bg-white border rounded p-6 text-slate-400">No statements for this account yet.</div>`;
  if (statement) {
    const s = statement;
    const totalExcl = s.property_rates_excl_vat + s.elec_excl_vat + s.water_excl_vat + s.sanitation_excl_vat + s.refuse_excl_vat + s.sundry_excl_vat;
    const totalVat = s.property_rates_vat + s.elec_vat + s.water_vat + s.sanitation_vat + s.refuse_vat + s.sundry_vat;

    // Electricity sub-rows: TOU accounts get Off-peak/Peak/Standard, flat-rate accounts get a
    // single Energy line, Demand/Reactive/Service/Network surcharge apply to either - only shown
    // if non-zero (combined-mode statements may mix TOU and flat accounts together). Sub-rows show
    // excl-VAT Rand only (VAT/total columns left blank) since COJ's electricity VAT is one combined
    // figure for the whole section, not per-line - avoids implying a false split.
    const elecSubRowsClean = [
      ['Off-peak', s.elec_off_peak_kwh, 'kWh', s.elec_off_peak_rand],
      ['Peak', s.elec_peak_kwh, 'kWh', s.elec_peak_rand],
      ['Standard', s.elec_standard_kwh, 'kWh', s.elec_standard_rand],
      ['Energy (flat rate)', s.elec_energy_kwh, 'kWh', s.elec_energy_rand],
      ['Demand', s.elec_demand_kva, 'kVA', s.elec_demand_rand],
      ['Reactive energy', s.elec_reactive_kvarh, 'kVArh', s.elec_reactive_rand],
      ['Service charge', null, null, s.elec_service_rand],
      ['Network surcharge', null, null, s.elec_network_surcharge_rand],
    ].filter(([, , , rand]) => Math.abs(rand || 0) > 0.005)
      .map(([label, qty, unit, rand]) => `<tr class="border-t text-slate-500">
        <td class="py-1 pl-6 text-sm">${esc(label)}</td>
        <td class="py-1 text-right text-sm">${qty != null ? fmtNum(qty, 1) + ' ' + unit : '&mdash;'}</td>
        <td class="py-1 text-right text-sm">${money(rand)}</td>
        <td class="py-1"></td><td class="py-1"></td>
      </tr>`).join('');

    const tariffBadge = s.elec_tariff_type === 'TOU' ? 'bg-blue-100 text-blue-700'
      : s.elec_tariff_type === 'mixed' ? 'bg-purple-100 text-purple-700' : 'bg-slate-200 text-slate-600';
    const tariffLabel = s.elec_tariff_type === 'TOU' ? 'Time-of-Use electricity tariff'
      : s.elec_tariff_type === 'mixed' ? 'Mixed (TOU + flat-rate) accounts combined' : 'Flat-rate electricity tariff';

    const missingNote = combinedInfo && combinedInfo.missingAccounts.length
      ? `<div class="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-b">No "${esc(s.statement_for)}" statement found yet for: ${combinedInfo.missingAccounts.map(esc).join(', ')} &mdash; combined totals below exclude ${combinedInfo.missingAccounts.length === 1 ? 'it' : 'them'}.</div>`
      : '';

    breakdownHtml = `
    <div class="bg-white rounded-lg border mb-6">
      <div class="px-4 py-3 border-b font-semibold flex justify-between items-baseline flex-wrap gap-2">
        <span>Statement for ${esc(s.statement_for)}${s.invoice_number ? ` <span class="text-slate-400 font-normal text-sm">(invoice ${esc(s.invoice_number)}, issued ${esc(s.statement_date)})</span>` : ` <span class="text-slate-400 font-normal text-sm">(combining ${combinedInfo.matchedAccounts.length} account${combinedInfo.matchedAccounts.length === 1 ? '' : 's'}: ${combinedInfo.matchedAccounts.map(esc).join(', ')})</span>`}</span>
        <div class="flex items-center gap-2">
          <span class="badge ${tariffBadge}">${tariffLabel}</span>
          ${pdfUrl ? `<a href="${pdfUrl}" class="bg-slate-900 text-white rounded px-3 py-1.5 text-sm font-medium">Download PDF</a>` : ''}
        </div>
      </div>
      ${missingNote}
      <div class="px-4 py-3">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-slate-500 border-b">
            <th class="py-1 pl-2">Category</th><th class="py-1 text-right">Consumption</th>
            <th class="py-1 text-right">Excl. VAT</th><th class="py-1 text-right">VAT</th><th class="py-1 text-right">Total</th>
          </tr></thead>
          <tbody>
            ${catRow('Property Rates', null, null, s.property_rates_excl_vat, s.property_rates_vat, s.property_rates_incl_vat)}
            ${catRowHtml('Electricity' + (s.elec_reading_start ? ` <span class="text-slate-400 text-xs">(${esc(s.elec_reading_start)} to ${esc(s.elec_reading_end)})</span>` : ''), s.elec_consumption_kwh, 'kWh', s.elec_excl_vat, s.elec_vat, s.elec_incl_vat)}
            ${elecSubRowsClean}
            ${catRowHtml('Water' + (s.water_reading_start ? ` <span class="text-slate-400 text-xs">(${esc(s.water_reading_start)} to ${esc(s.water_reading_end)})</span>` : ''), s.water_consumption_kl, 'KL', s.water_excl_vat, s.water_vat, s.water_incl_vat)}
            ${catRowHtml('Sanitation <span class="text-slate-400 text-xs">(billed on water consumption)</span>', s.water_consumption_kl, 'KL', s.sanitation_excl_vat, s.sanitation_vat, s.sanitation_incl_vat)}
            ${catRow('Refuse', null, null, s.refuse_excl_vat, s.refuse_vat, s.refuse_incl_vat)}
            ${catRow('Sundry', null, null, s.sundry_excl_vat, s.sundry_vat, s.sundry_incl_vat)}
            ${catRow('Total Charges', null, null, totalExcl, totalVat, s.grand_total_incl_vat, { total: true })}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  let comparisonHtml = '';
  if (comparison) {
    if (!comparison.period) {
      comparisonHtml = `<div class="bg-white border rounded p-4 mb-6 text-slate-400">No internal billing period overlaps this statement's reading dates yet.</div>`;
    } else if (!comparison.ours || comparison.ours.tenant_count === 0) {
      comparisonHtml = `<div class="bg-white border rounded p-4 mb-6 text-slate-400">No internal billing data for site "${esc(comparison.siteName)}" in the matching period (${esc(comparison.period.label)}) yet.</div>`;
    } else {
      const variance = (a, b) => (b ? ((a - b) / b) * 100 : 0);
      const compRow = (label, ourVal, cojVal, unit) => `<tr class="border-t">
        <td class="py-1.5 pl-2">${esc(label)}</td>
        <td class="py-1.5 text-right">${unit === 'R' ? money(ourVal) : fmtNum(ourVal, 1) + ' ' + unit}</td>
        <td class="py-1.5 text-right">${unit === 'R' ? money(cojVal) : fmtNum(cojVal, 1) + ' ' + unit}</td>
        <td class="py-1.5 text-right ${Math.abs(variance(ourVal, cojVal)) < 5 ? 'text-green-600' : 'text-amber-600'}">${variance(ourVal, cojVal).toFixed(1)}%</td>
      </tr>`;
      comparisonHtml = `
      <div class="bg-white rounded-lg border mb-6">
        <div class="px-4 py-3 border-b font-semibold">Our billing vs. the utility &mdash; ${esc(comparison.siteName)}</div>
        <div class="px-4 pt-2 text-xs text-slate-400">Matched to our billing period <b>${esc(comparison.period.label)}</b> (${esc(comparison.period.start_date)} to ${esc(comparison.period.end_date)}), the closest overlap with this statement's own reading dates (~${comparison.overlapDays} days overlap). ${comparison.coj.matched.length > 1 ? `Utility side combines ${comparison.coj.matched.map((m) => esc(m.account)).join(' + ')}.` : ''}</div>
        <div class="px-4 py-3">
          <table class="w-full text-sm">
            <thead><tr class="text-left text-slate-500 border-b">
              <th class="py-1 pl-2"></th><th class="py-1 text-right">Our billing (tenants)</th>
              <th class="py-1 text-right">Utility (COJ)</th><th class="py-1 text-right">Variance</th>
            </tr></thead>
            <tbody>
              ${compRow('Electricity consumption', comparison.ours.elec_kwh, comparison.coj.elecKwh, 'kWh')}
              ${compRow('Electricity charge', comparison.ours.elec_rand, comparison.coj.elecRand, 'R')}
              ${compRow('Water consumption', comparison.ours.water_kl, comparison.coj.waterKl, 'KL')}
              ${compRow('Water & sanitation charge', comparison.ours.water_rand, comparison.coj.waterRand, 'R')}
            </tbody>
          </table>
          <p class="text-xs text-slate-400 mt-2">"Our billing" sums what we invoice ${comparison.ours.tenant_count} tenant(s) on this site for the matched period; the utility figure is what COJ billed the bulk account(s) supplying that same site. A gap is expected (common-area/park losses, timing misalignment between the two billing cycles) &mdash; large or growing gaps are worth investigating.</p>
        </div>
      </div>`;
    }
  }

  const body = `
  <div class="flex items-center justify-between mb-1 flex-wrap gap-3">
    <h1 class="text-2xl font-bold">Municipality Accounts</h1>
    <form method="get" action="/municipal-accounts" class="flex items-center gap-2 flex-wrap">
      <label class="text-sm text-slate-500">Account:</label>
      <select name="accountId" onchange="this.form.submit()" class="border rounded px-3 py-2 text-sm">
        ${accounts.map((a) => `<option value="${a.id}" ${!isCombined && account && a.id === account.id ? 'selected' : ''}>${esc(a.label)} (${esc(a.account_number)})</option>`).join('')}
        <option value="all" ${isCombined ? 'selected' : ''}>All Accounts (Combined)</option>
      </select>
      <label class="text-sm text-slate-500">Statement:</label>
      ${isCombined ? `
      <select name="statementFor" class="border rounded px-3 py-2 text-sm">
        ${(statementLabels || []).map((l) => `<option value="${esc(l.statement_for)}" ${selectedStatementFor === l.statement_for ? 'selected' : ''}>${esc(l.statement_for)}</option>`).join('')}
      </select>` : `
      <select name="statementId" class="border rounded px-3 py-2 text-sm">
        ${statements.map((s) => `<option value="${s.id}" ${statement && s.id === statement.id ? 'selected' : ''}>${esc(s.statement_for)} (${esc(s.statement_date)})</option>`).join('')}
      </select>`}
      <button class="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium">View</button>
    </form>
  </div>
  <p class="text-sm text-slate-500 mb-4">City of Johannesburg bulk-supply statements for this physical stand. Each of the 4 accounts (Mini, Rittle, Industrial A, Industrial B) is billed directly by COJ, separate from tenant billing. Note: COJ's own billing periods don't line up with this app's billing periods, and a statement's own label can run about a month ahead of the reading period it actually covers. "All Accounts (Combined)" sums all 4 accounts for a chosen statement month and compares it against our total billing across every tenant, every site.</p>
  ${breakdownHtml}
  ${comparisonHtml}
  ${!isCombined && statements.length ? `
  <div class="bg-white rounded-lg border overflow-hidden">
    <div class="px-4 py-3 border-b font-semibold">All statements for this account</div>
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Statement for</th><th class="px-4 py-2">Issued</th>
        <th class="px-4 py-2 text-right">Elec kWh</th><th class="px-4 py-2 text-right">Water KL</th>
        <th class="px-4 py-2 text-right">Total (incl. VAT)</th><th class="px-4 py-2"></th>
      </tr></thead>
      <tbody>
      ${statements.slice().reverse().map((s) => `<tr class="border-b last:border-0 ${statement && s.id === statement.id ? 'bg-slate-50' : ''}">
        <td class="px-4 py-2 font-medium">${esc(s.statement_for)}</td>
        <td class="px-4 py-2 text-slate-500">${esc(s.statement_date)}</td>
        <td class="px-4 py-2 text-right">${fmtNum(s.elec_consumption_kwh, 0)}</td>
        <td class="px-4 py-2 text-right">${fmtNum(s.water_consumption_kl, 0)}</td>
        <td class="px-4 py-2 text-right font-medium">${money(s.grand_total_incl_vat)}</td>
        <td class="px-4 py-2 text-right"><a class="text-blue-600 hover:underline" href="/municipal-accounts?accountId=${account.id}&statementId=${s.id}">View</a></td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}`;
  return layout({ title: 'Municipality Accounts', user, active: '/municipal-accounts', body });
}

function reconciliationPage({ user, rows, summary }) {
  const body = `
  <h1 class="text-2xl font-bold mb-1">Reconciliation: App vs. Source Workbook</h1>
  <p class="text-sm text-slate-500 mb-4">Every tenant, every utility, both imported months (March &amp; April 2026). The app independently recomputes each charge from raw meter readings and the versioned tariff tables; the "Excel total" column is the workbook's own cached formula result.</p>
  <div class="grid grid-cols-3 gap-4 mb-6 max-w-xl">
    ${statCard('Exact match', summary.exact)}
    ${statCard('Within 1% (rounding)', summary.close)}
    ${statCard('Variance &gt; 1%', summary.off)}
  </div>
  <div class="bg-white rounded-lg border overflow-hidden">
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Tenant</th><th class="px-4 py-2">Period</th><th class="px-4 py-2">Utility</th>
        <th class="px-4 py-2 text-right">Excel (excl. VAT)</th><th class="px-4 py-2 text-right">App (excl. VAT)</th>
        <th class="px-4 py-2 text-right">Variance</th><th class="px-4 py-2 text-right">%</th>
      </tr></thead>
      <tbody>
      ${rows.map(r => `<tr class="border-b last:border-0">
        <td class="px-4 py-2">${esc(r.tenant)}</td>
        <td class="px-4 py-2 text-slate-500">${esc(r.period)}</td>
        <td class="px-4 py-2 capitalize">${esc(r.utility_type)}</td>
        <td class="px-4 py-2 text-right">${money(r.excel_total)}</td>
        <td class="px-4 py-2 text-right">${money(r.app_total)}</td>
        <td class="px-4 py-2 text-right ${Math.abs(r.diff) < 0.05 ? 'text-green-600' : (r.pct < 1 ? 'text-amber-600' : 'text-red-600')}">${money(r.diff)}</td>
        <td class="px-4 py-2 text-right">${r.pct.toFixed(2)}%</td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
  return layout({ title: 'Reconciliation', user, active: '/reconciliation', body });
}

function auditLogPage({ user, entries }) {
  const body = `
  <h1 class="text-2xl font-bold mb-4">Audit Log</h1>
  <div class="bg-white rounded-lg border overflow-hidden">
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Time</th><th class="px-4 py-2">User</th><th class="px-4 py-2">Action</th>
        <th class="px-4 py-2">Entity</th><th class="px-4 py-2">Field</th><th class="px-4 py-2">Old</th><th class="px-4 py-2">New</th><th class="px-4 py-2">Reason</th>
      </tr></thead>
      <tbody>
      ${entries.map(e => `<tr class="border-b last:border-0">
        <td class="px-4 py-2 text-slate-500">${esc(e.timestamp)}</td>
        <td class="px-4 py-2">${esc(e.username || 'system')}</td>
        <td class="px-4 py-2">${esc(e.action)}</td>
        <td class="px-4 py-2">${esc(e.entity_type)}#${e.entity_id ?? ''}</td>
        <td class="px-4 py-2">${esc(e.field || '-')}</td>
        <td class="px-4 py-2">${esc(e.old_value || '-')}</td>
        <td class="px-4 py-2">${esc(e.new_value || '-')}</td>
        <td class="px-4 py-2">${esc(e.reason || '-')}</td>
      </tr>`).join('') || '<tr><td class="px-4 py-3 text-slate-400" colspan="8">No audit entries yet</td></tr>'}
      </tbody>
    </table>
  </div>`;
  return layout({ title: 'Audit Log', user, active: '/audit-log', body });
}

module.exports = {
  esc, money, fmtNum, layout, loginPage, dashboardPage, tenantsPage, tenantDetailPage,
  metersPage, tariffsPage, billingPeriodsPage, newBillingPeriodPage, readingsCapturePage,
  readingsResultPage, billingSelectorPage, billDetailPage,
  solarBillingSlipsPage, municipalAccountsPage,
  reconciliationPage, auditLogPage, statusColor,
};
