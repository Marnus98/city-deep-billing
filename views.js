// views.js - server-rendered HTML. Plain template-literal functions (no templating engine
// dependency). Tailwind is loaded from the CDN by the *browser* viewing the page - that's
// independent of this sandbox's own package-registry access, so it's safe to rely on here.
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
    ['/billing-periods', 'Billing Periods'], ['/billing', 'Billing'], ['/tariffs', 'Tariffs'],
    ['/reconciliation', 'Reconciliation'], ['/audit-log', 'Audit Log'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} - City Deep Billing</title>
<link rel="stylesheet" href="/style.css"/>
</head>
<body class="bg-slate-50 text-slate-800">
${user ? `
<div class="bg-slate-900 text-white">
  <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-6">
      <span class="font-bold text-lg">City Deep Billing</span>
      <nav class="flex gap-4 text-sm">
        ${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'text-white font-semibold' : 'text-slate-300 hover:text-white'}">${label}</a>`).join('')}
      </nav>
    </div>
    <div class="flex items-center gap-3 text-sm">
      <span class="text-slate-300">${esc(user.fullName)} <span class="badge bg-slate-700 text-slate-100">${esc(user.role)}</span></span>
      <a href="/logout" class="text-slate-300 hover:text-white">Log out</a>
    </div>
  </div>
</div>` : ''}
<div class="max-w-7xl mx-auto px-4 py-6">
${body}
</div>
</body>
</html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Sign in - City Deep Billing</title>
  <link rel="stylesheet" href="/style.css"/></head>
  <body class="bg-slate-100 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-xl shadow p-8 w-full max-w-sm">
    <h1 class="text-xl font-bold mb-1">City Deep Billing</h1>
    <p class="text-sm text-slate-500 mb-6">Sign in to continue</p>
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

function dashboardPage({ user, stats, recentBills, missing, currentPeriod }) {
  const body = `
  <div class="flex items-center justify-between mb-4">
    <h1 class="text-2xl font-bold">Dashboard</h1>
    <div class="text-sm text-slate-500">Current billing month: <span class="font-semibold text-slate-700">${esc(currentPeriod?.label || '-')}</span></div>
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
    ${statCard('Total water consumption', fmtNum(stats.totalWaterM3, 0) + ' m&sup3;')}
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
  <h1 class="text-2xl font-bold mb-4">Billing Periods</h1>
  <div class="bg-white rounded-lg border overflow-hidden">
    <table class="w-full text-sm">
      <thead><tr class="text-left border-b bg-slate-50">
        <th class="px-4 py-2">Label</th><th class="px-4 py-2">Start</th><th class="px-4 py-2">End</th>
        <th class="px-4 py-2">Due date</th><th class="px-4 py-2 text-right">Bills</th>
      </tr></thead>
      <tbody>
      ${periods.map(p => `<tr class="border-b last:border-0">
        <td class="px-4 py-2 font-medium">${esc(p.label)}</td>
        <td class="px-4 py-2">${esc(p.start_date)}</td>
        <td class="px-4 py-2">${esc(p.end_date)}</td>
        <td class="px-4 py-2">${esc(p.due_date || '-')}</td>
        <td class="px-4 py-2 text-right">${p.bill_count}</td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
  return layout({ title: 'Billing Periods', user, active: '/billing-periods', body });
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
        <tbody>${meters.map(m => `<tr class="border-t"><td class="py-1 font-mono">${esc(m.serial)}</td><td>${fmtNum(m.start_reading, 2)}</td><td>${fmtNum(m.end_reading, 2)}</td><td>${fmtNum(m.end_reading - m.start_reading, 2)}</td></tr>`).join('') || '<tr><td class="py-1 text-slate-400" colspan="4">No meter readings</td></tr>'}</tbody>
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
  metersPage, tariffsPage, billingPeriodsPage, billingSelectorPage, billDetailPage,
  reconciliationPage, auditLogPage, statusColor,
};
