// solar_sizing_ui.js - browser UI for the 8 Field Street Solar Sizing page. Reads window.SS_DATA
// (months, rates, tariff name) and uses window.SolarSizing (solar_sizing_model.js). Pure client
// code: no network calls, nothing is saved.
(function () {
  'use strict';
  const M = window.SolarSizing, D = window.SS_DATA;
  const $ = (id) => document.getElementById(id);
  const MN = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const fmtR = (v) => (v < 0 ? '-' : '') + 'R ' + Math.abs(v).toLocaleString('en-ZA', { maximumFractionDigits: 0 }).replace(/ /g, ' ');
  const fmtM = (v) => (v < 0 ? '-' : '') + 'R ' + (Math.abs(v) / 1e6).toFixed(2) + 'm';
  const fmtM1 = (v) => (v < 0 ? '-' : '') + 'R ' + (Math.abs(v) / 1e6).toFixed(1) + 'm';
  const fmtN = (v, d) => Number(v).toLocaleString('en-ZA', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }).replace(/ /g, ' ');
  const fmtP = (v) => (v === null || v === undefined || !isFinite(v) ? 'n/a' : (v * 100).toFixed(0) + '%');
  const fmtY = (v) => (v === null || v === undefined || !isFinite(v) ? 'never' : v.toFixed(1) + ' yr');
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) ? v : 0; };

  function assumptions() {
    const prime = num('i_prime') / 100, spread = num('i_spread') / 100;
    return {
      yield: num('i_yield'), eff: num('i_eff') / 100, dod: num('i_dod') / 100,
      degPv: num('i_degpv') / 100, degBat: num('i_degbat') / 100, pvLife: Math.max(1, Math.round(num('i_pvlife'))), batLife: Math.max(1, Math.round(num('i_batlife'))),
      esc: num('i_esc') / 100, maint: num('i_maint') / 100, ins: num('i_ins') / 100, maintEsc: num('i_mesc') / 100,
      prime, ppaSpread: spread, disc: $('i_disc').value === '' ? prime + spread : num('i_disc') / 100,
      loanTerm: Math.max(1, Math.round(num('i_loan'))), ppaEsc: num('i_ppaesc') / 100,
      mount: $('i_mount').value, rateRoof: num('i_rroof'), rateGround: num('i_rground'), rateBat: 0,
      dcacMax: num('i_dcac') || 1.5, cmax: 1 / Math.max(0.5, num('i_hours') || 2), hybridGp: num('i_gp'), hybridBrand: $('i_brand').value, panelRpw: 2.45,
    };
  }

  let ctx = null, ctxKey = '';
  function getCtx(a) {
    const key = a.yield + '|' + JSON.stringify(D.rates);
    if (!ctx || key !== ctxKey) { ctx = M.makeContext({ months: D.months, rates: D.rates }, a); ctxKey = key; }
    return ctx;
  }

  // ---------------- tiny SVG helpers
  function svgOpen(w, h) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">'; }
  function txt(x, y, s, o) { o = o || {}; return '<text x="' + x + '" y="' + y + '" font-size="' + (o.size || 11) + '" fill="' + (o.fill || '#64748b') + '" text-anchor="' + (o.anchor || 'start') + '"' + (o.bold ? ' font-weight="700"' : '') + '>' + s + '</text>'; }
  function line(x1, y1, x2, y2, c, w, dash) { return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + c + '" stroke-width="' + (w || 1) + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>'; }

  function chartBaseline() {
    const L = 52, T = 12, W = 560, H = 190, mx = 1; let max = 0;
    D.months.forEach((m) => { max = Math.max(max, m.p + m.s + m.o); });
    max = Math.ceil(max / 50000) * 50000 || 50000;
    let s = svgOpen(640, 250);
    for (let i = 0; i <= 5; i++) { const y = T + H - H * i / 5; s += line(L, y, L + W, y, '#e2e8f0') + txt(L - 6, y + 4, Math.round(max * i / 5 / 1000) + 'k', { anchor: 'end' }); }
    const bw = W / Math.max(1, D.months.length);
    D.months.forEach((m, i) => {
      let y = T + H;
      [['o', '#2f6db5'], ['s', '#f2a33a'], ['p', '#d8573c']].forEach((k) => { const h = H * m[k[0]] / max; y -= h; s += '<rect x="' + (L + i * bw + 5) + '" y="' + y + '" width="' + (bw - 10) + '" height="' + h + '" fill="' + k[1] + '"/>'; });
      s += txt(L + i * bw + bw / 2, T + H + 15, MN[m.m] + (m.label ? ' ' + String(m.label).slice(2, 4) : ''), { anchor: 'middle', size: 10 });
    });
    return s + '</svg>';
  }

  function chartLine(series, o) {
    // series: [{pts:[[x,y]...], color, dash, label}], o: {w,h,xlab,ylab,fmtY,mark:[x,y], hline:[y,label]}
    const L = 56, T = 12, W = 560, H = 190;
    let xs = [], ys = [];
    series.forEach((s) => s.pts.forEach((p) => { xs.push(p[0]); ys.push(p[1]); }));
    if (o.hline) ys.push(o.hline[0]);
    let x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys.concat([0])), y1 = Math.max.apply(null, ys.concat([0]));
    if (y1 === y0) y1 = y0 + 1; if (x1 === x0) x1 = x0 + 1;
    const pad = (y1 - y0) * 0.08; y1 += pad; if (y0 < 0) y0 -= pad;
    const X = (x) => L + W * (x - x0) / (x1 - x0), Y = (y) => T + H - H * (y - y0) / (y1 - y0);
    let s = svgOpen(640, 250);
    for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4; s += line(L, Y(v), L + W, Y(v), '#e2e8f0') + txt(L - 6, Y(v) + 4, o.fmtY ? o.fmtY(v) : v.toFixed(1), { anchor: 'end' }); }
    if (y0 < 0) s += line(L, Y(0), L + W, Y(0), '#64748b', 1.2);
    const ticks = o.xticks || [x0, (x0 + x1) / 2, x1];
    ticks.forEach((v) => { s += txt(X(v), T + H + 15, (o.fmtX ? o.fmtX(v) : fmtN(v)), { anchor: 'middle', size: 10 }); });
    series.forEach((sr) => { s += '<polyline fill="none" stroke="' + sr.color + '" stroke-width="2.6"' + (sr.dash ? ' stroke-dasharray="' + sr.dash + '"' : '') + ' points="' + sr.pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ') + '"/>'; });
    if (o.hline) { s += line(L, Y(o.hline[0]), L + W, Y(o.hline[0]), '#a15c00', 1.4, '5 4') + txt(L + W, Y(o.hline[0]) - 4, o.hline[1], { anchor: 'end', fill: '#a15c00' }); }
    if (o.mark) { s += '<circle cx="' + X(o.mark[0]) + '" cy="' + Y(o.mark[1]) + '" r="6" fill="#b8212f"/>' + txt(X(o.mark[0]) + 9, Y(o.mark[1]) - 8, o.mark[2] || '', { fill: '#b8212f', bold: true }); }
    s += txt(L + W, T + H + 32, o.xlab || '', { anchor: 'end', size: 10 });
    return s + '</svg>';
  }

  function legend(items) { return '<div class="ss-legend">' + items.map((i) => '<span><i style="background:' + i[0] + '"></i>' + i[1] + '</span>').join('') + '</div>'; }

  // ---------------- main compute + render
  let recommended = null;

  function runOptimiser(a, c) {
    const pvSizes = []; for (let k = 100; k <= 1500; k += 50) pvSizes.push(k);
    const pvRows = M.sweepPv(c, a, pvSizes);
    const pvBest = M.pickPv(pvRows, num('i_hurdlepv'));
    const batSizes = []; for (let k = 100; k <= 2000; k += 100) batSizes.push(k);
    const hr = Math.max(0.5, num('i_hours'));
    const batRows = M.sweepHybrid(c, a, pvBest.kwp, 1500, batSizes, hr, 'C');
    const k0 = M.evaluate(c, a, 'A', pvBest.kwp, 0, 0);
    // hybrid: largest size whose marginal payback (extra PV + battery + inverter) stays within the hurdle and adds NPV vs PV only
    let best = null; const hb = num('i_hurdlebat');
    for (let i = 0; i < batRows.length; i++) {
      const r = batRows[i];
      if (r.margPay <= hb && r.dNpvVsPv > 0) best = r; else if (best) break;
    }
    return { pvRows, pvBest, batRows, batBest: best, pvOnly: k0 };
  }

  function recalcAssumptionsOnly() { recommended = null; recalc(); }

  function setSizesFromRecommendation() {
    if (!recommended) return;
    $('i_kwp').value = recommended.batBest ? recommended.batBest.kwp : recommended.pvBest.kwp;
    if (recommended.batBest) { $('i_kwh').value = recommended.batBest.kwh; $('i_pkw').value = Math.round(recommended.batBest.pkw); }
    else { $('i_kwh').value = 0; $('i_pkw').value = 0; }
    if (recommended.batBest) $('i_scen').value = 'C'; else $('i_scen').value = 'A';
  }

  function recalc(resetSizes) {
    if (!D.months.length) { $('ss-out').innerHTML = '<div class="ss-warn">No billing slips found for this site yet.</div>'; return; }
    const a = assumptions(); const c = getCtx(a);
    if (!recommended) { recommended = runOptimiser(a, c); if (resetSizes !== false) setSizesFromRecommendation(); }
    const kwp = num('i_kwp'), kwh = num('i_kwh'), pkw = num('i_pkw');
    const base = M.baseline(c);
    const A = M.evaluate(c, a, 'A', kwp, 0, 0);
    const B = M.evaluate(c, a, 'B', kwp, kwh, pkw);
    const C = M.evaluate(c, a, 'C', kwp, kwh, pkw);
    const scen = $('i_scen').value; const S = scen === 'B' ? B : scen === 'C' ? C : A;
    const hasBat = kwh > 0 && pkw > 0;

    const per = base.per; const cost = base.costPer;
    const peakDay = (function () { let hi = 0, lo = 0, dh = 0, dl = 0; const cal = M.CAL; const ld = c.load; const seen = {}; for (let i = 0; i < cal.n; i++) { if (cal.per[i] === 'p') { const hiS = !!M.HIGH[cal.month[i]]; const k = cal.month[i] + '-' + Math.floor(i / 24); if (hiS) { hi += ld[i]; } else { lo += ld[i]; } seen[k] = hiS; } } Object.keys(seen).forEach((k) => { if (seen[k]) dh++; else dl++; }); return { hi: dh ? hi / dh : 0, lo: dl ? lo / dl : 0 }; })();
    const maxKva = Math.max.apply(null, D.months.map((m) => m.kva)), minKva = Math.min.apply(null, D.months.map((m) => m.kva));
    const annualBill = base.energyCost; const fixedYr = 12 * (D.fixed.basic) + D.months.reduce((s, m) => s + m.kva * (D.fixed.demand + D.fixed.nac), 0) * (12 / D.months.length);

    // ---- recommendation banner
    const rb = recommended.batBest;
    let banner = '<h3>Engineering recommendation <span class="ss-tag">optimiser</span></h3>';
    banner += '<div class="ss-big">PV ' + fmtN(rb ? rb.kwp : recommended.pvBest.kwp) + ' kWp' + (rb ? ' + DC-coupled hybrid: ' + fmtN(rb.kwh) + ' kWh battery, ' + fmtN(rb.pkw) + ' kW inverter' : ' (no battery justified)') + '</div>';
    banner += '<p>PV-only is priced at the applied R/Wp rates and stops paying where each extra 50 kWp passes ' + num('i_hurdlepv') + ' years. The hybrid (DC-coupled, one inverter for PV and battery) is priced with the Sigenergy / Solis costing; extra PV, battery and inverter are added while each step pays back inside ' + num('i_hurdlebat') + ' years. Change the hurdles or any price and the recommendation re-runs. The sizes below are editable.</p>';
    $('ss-reco').innerHTML = banner;

    // ---- chips for current configuration
    const chips = [
      ['CAPEX', fmtM(S.capex), 'PV ' + fmtM(S.capPv) + (S.capBat ? ' + battery ' + fmtM(S.capBat) : '')],
      ['PV generation', fmtN(S.sim.pvGen / 1000) + ' MWh', fmtN(S.sim.pvUsed / S.sim.pvGen * 100) + '% self-consumed'],
      ['Solar share of load', fmtN(S.sim.pvUsed / base.kwh * 100) + '%', 'of ' + fmtN(base.kwh / 1000) + ' MWh/yr'],
      ['Year-1 saving (net)', fmtM(S.cash.y1Net), 'after maintenance + insurance'],
      ['Cash payback', fmtY(S.cash.pay), 'simple, escalated'],
      ['NPV / IRR', fmtM1(S.cash.npv) + ' / ' + fmtP(S.cash.irr), '@ ' + (a.disc * 100).toFixed(1) + '% discount'],
      ['PPA starting tariff', 'R ' + S.ppa.p0.toFixed(2) + '/kWh', 'investor earns prime + ' + (a.ppaSpread * 100).toFixed(1) + '%'],
      ['Avoided municipal cost', 'R ' + S.avoided.toFixed(2) + '/kWh', 'blended, year 1'],
    ];
    $('ss-chips').innerHTML = chips.map((x, i) => '<div class="ss-chip' + (i < 4 ? ' hi' : '') + '"><span>' + x[0] + '</span><b>' + x[1] + '</b><small>' + x[2] + '</small></div>').join('');

    // ---- scenario table
    const cols = [['0  No installation', null], ['A  PV only', A], ['B  PV + BESS, solar charging', B], ['C  PV + BESS, solar + grid charging', C]];
    const rowDef = [
      ['CAPEX (ex VAT)', (e) => e ? fmtM(e.capex) : '-'],
      ['PV / battery', (e) => e ? fmtN(e.kwp) + ' kWp' + (e.kwh ? ' / ' + fmtN(e.kwh) + ' kWh, ' + fmtN(e.pkw) + ' kW' : '') : '-'],
      ['PV generation (MWh/yr)', (e) => e ? fmtN(e.sim.pvGen / 1000) : '0'],
      ['PV used on site (MWh/yr)', (e) => e ? fmtN(e.sim.pvUsed / 1000) : '0'],
      ['Battery discharged (MWh/yr)', (e) => e ? fmtN(e.sim.dis / 1000) : '0'],
      ['Spilled PV (MWh/yr)', (e) => e ? fmtN(e.sim.spill / 1000) : '-'],
      ['Grid energy cost, year 1', (e) => e ? fmtM(annualBill - e.sim.savingPv - e.sim.arb) : fmtM(annualBill)],
      ['Annual saving, year 1 (gross)', (e) => e ? fmtM(e.sim.savingPv + e.sim.arb) : '-'],
      ['  of which PV', (e) => e ? fmtM(e.sim.savingPv) : '-'],
      ['  of which battery arbitrage', (e) => e ? fmtM(e.sim.arb) : '-'],
      ['Cash: simple payback', (e) => e ? fmtY(e.cash.pay) : '-'],
      ['Cash: NPV / IRR', (e) => e ? fmtM1(e.cash.npv) + ' / ' + fmtP(e.cash.irr) : '-'],
      ['PPA starting tariff (R/kWh)', (e) => e ? e.ppa.p0.toFixed(2) : '-'],
    ];
    const best = [A, B, C].reduce((x, y) => (y.cash.npv > x.cash.npv ? y : x));
    let t = '<table class="ss-t"><thead><tr><th></th>' + cols.map((c2, i) => '<th class="n' + (c2[1] === best ? ' star' : '') + '">' + c2[0] + (c2[1] === best ? ' (best NPV)' : '') + '</th>').join('') + '</tr></thead><tbody>';
    rowDef.forEach((r) => { t += '<tr><td>' + r[0] + '</td>' + cols.map((c2) => '<td class="n' + (c2[1] === best ? ' star' : '') + '">' + r[1](c2[1]) + '</td>').join('') + '</tr>'; });
    t += '</tbody></table>';
    if (B.cash.npv < A.cash.npv) t += '<div class="ss-warn">Scenario B: charging the battery from solar surplus alone does not pay for itself (the site\'s daytime load absorbs almost all PV). The battery only earns its cost when it can also charge from the grid off-peak (scenario C).</div>';
    $('ss-scen').innerHTML = t;

    // ---- finance routes (for the chosen scenario)
    const fin = S.fin, ppa = S.ppa, ppaFlat = S.ppaFlat;
    let f = '<div class="ss-fin"><div class="ss-finc"><h4>Cash, simple payback</h4><dl><dt>Upfront</dt><dd>' + fmtM(S.capex) + '</dd><dt>Year-1 net saving</dt><dd>' + fmtM(S.cash.y1Net) + '</dd><dt>Simple payback</dt><dd>' + fmtY(S.cash.pay) + '</dd><dt>Total net over life</dt><dd>' + fmtM1(S.cash.total) + '</dd></dl></div>';
    f += '<div class="ss-finc"><h4>Cash, time value of money</h4><dl><dt>Discount rate</dt><dd>' + (a.disc * 100).toFixed(1) + '%</dd><dt>NPV</dt><dd>' + fmtM1(S.cash.npv) + '</dd><dt>IRR</dt><dd>' + fmtP(S.cash.irr) + '</dd><dt>Discounted payback</dt><dd>' + fmtY(S.cash.dpay) + '</dd></dl></div>';
    f += '<div class="ss-finc"><h4>Financed at prime</h4><dl><dt>Rate / term</dt><dd>' + (a.prime * 100).toFixed(2) + '% / ' + a.loanTerm + ' yr</dd><dt>Annual repayment</dt><dd>' + fmtM(fin.pmt) + '</dd><dt>Year-1 net cash</dt><dd>' + fmtM(fin.y1Net) + '</dd><dt>Interest paid</dt><dd>' + fmtM(fin.interest) + '</dd><dt>NPV</dt><dd>' + fmtM1(fin.npv) + '</dd></dl></div>';
    f += '<div class="ss-finc"><h4>PPA at prime + ' + (a.ppaSpread * 100).toFixed(1) + '%</h4><dl><dt>Investor return</dt><dd>' + (ppa.ir * 100).toFixed(1) + '%</dd><dt>Start tariff (' + (a.ppaEsc * 100).toFixed(1) + '% esc)</dt><dd>R ' + ppa.p0.toFixed(3) + '/kWh</dd><dt>Flat, no escalation</dt><dd>R ' + ppaFlat.p0.toFixed(3) + '/kWh</dd><dt>Client saves, year 1</dt><dd>' + fmtM(ppa.y1Client) + '</dd><dt>Client NPV</dt><dd>' + fmtM1(ppa.clientNpv) + '</dd></dl></div></div>';
    f += '<p class="ss-cap">The PPA tariff is the cost-reflective floor: the lowest price at which an investor still earns prime + ' + (a.ppaSpread * 100).toFixed(1) + '% after CAPEX, maintenance and insurance over the ' + a.pvLife + '-year PV life (battery ' + a.batLife + ' years). A commercial PPA would be priced between this floor and the municipal cost avoided (R ' + S.avoided.toFixed(2) + '/kWh).</p>';
    const cumCash = S.cash.cum.map((v, i) => [i, v / 1e6]);
    const cumFin = fin.cum.map((v, i) => [i, v / 1e6]);
    let cc = 0; const cumPpa = [[0, 0]]; ppa.client.forEach((v, i) => { cc += v; cumPpa.push([i + 1, cc / 1e6]); });
    f += '<div class="ss-cw">' + chartLine([{ pts: cumCash, color: '#b8212f' }, { pts: cumFin, color: '#2f6db5' }, { pts: cumPpa, color: '#12908e' }], { fmtY: (v) => v.toFixed(0) + 'm', fmtX: (v) => 'yr ' + Math.round(v), xticks: [0, 5, 10, 15, 20], xlab: 'cumulative cash position, R million' }) + '</div>';
    f += legend([['#b8212f', 'Cash purchase'], ['#2f6db5', 'Financed at prime'], ['#12908e', 'PPA (client side)']]);
    $('ss-fin').innerHTML = f;

    // ---- PV optimiser
    const pr = recommended.pvRows;
    let pvh = '<div class="ss-two"><div>' + chartLine([{ pts: pr.map((r) => [r.kwp, r.npv / 1e6]), color: '#b8212f' }], { fmtY: (v) => v.toFixed(0) + 'm', fmtX: (v) => fmtN(v), xticks: [100, 400, 700, 1000, 1300], mark: [recommended.pvBest.kwp, recommended.pvBest.npv / 1e6, fmtN(recommended.pvBest.kwp) + ' kWp'], xlab: 'PV NPV (R million) vs kWp' }) + '</div>';
    pvh += '<div>' + chartLine([{ pts: pr.filter((r) => r.margPay !== undefined && isFinite(r.margPay)).map((r) => [r.kwp, Math.min(r.margPay, 15)]), color: '#f2a33a' }], { fmtY: (v) => v.toFixed(0) + ' yr', fmtX: (v) => fmtN(v), xticks: [100, 400, 700, 1000, 1300], hline: [num('i_hurdlepv'), 'hurdle ' + num('i_hurdlepv') + ' yr'], xlab: 'marginal payback of each extra 50 kWp' }) + '</div></div>';
    pvh += '<div class="ss-scroll"><table class="ss-t ss-sm"><thead><tr><th>kWp</th><th class="n">CAPEX</th><th class="n">Used MWh</th><th class="n">Self-cons.</th><th class="n">Saving yr 1</th><th class="n">Payback</th><th class="n">NPV</th><th class="n">Marginal payback</th></tr></thead><tbody>';
    pr.filter((r, i) => r.kwp % 100 === 0 || r.kwp === recommended.pvBest.kwp).forEach((r) => {
      pvh += '<tr' + (r.kwp === recommended.pvBest.kwp ? ' class="ss-sel"' : '') + '><td>' + fmtN(r.kwp) + '</td><td class="n">' + fmtM(r.capex) + '</td><td class="n">' + fmtN(r.used / 1000) + '</td><td class="n">' + fmtN(r.used / r.gen * 100) + '%</td><td class="n">' + fmtM(r.saving) + '</td><td class="n">' + fmtY(r.pay) + '</td><td class="n">' + fmtM1(r.npv) + '</td><td class="n">' + (r.margPay === undefined ? '-' : fmtY(r.margPay)) + '</td></tr>';
    });
    pvh += '</tbody></table></div>';
    $('ss-pv').innerHTML = pvh;

    // ---- battery optimiser
    const br = recommended.batRows;
    let bh = '<div class="ss-two"><div>' + chartLine([{ pts: br.map((r) => [r.kwh, r.dNpvVsPv / 1e6]), color: '#12908e' }], { fmtY: (v) => v.toFixed(1) + 'm', fmtX: (v) => fmtN(v), xticks: [100, 600, 1100, 1600, 2000], mark: rb ? [rb.kwh, rb.dNpvVsPv / 1e6, fmtN(rb.kwh) + ' kWh'] : null, xlab: 'NPV added by the battery (R million) vs kWh' }) + '</div>';
    bh += '<div>' + chartLine([{ pts: br.filter((r) => r.margPay !== undefined && isFinite(r.margPay)).map((r) => [r.kwh, Math.min(r.margPay, 15)]), color: '#f2a33a' }], { fmtY: (v) => v.toFixed(0) + ' yr', fmtX: (v) => fmtN(v), xticks: [100, 600, 1100, 1600, 2000], hline: [num('i_hurdlebat'), 'hurdle ' + num('i_hurdlebat') + ' yr'], xlab: 'marginal payback of each extra 100 kWh' }) + '</div></div>';
    bh += '<div class="ss-scroll"><table class="ss-t ss-sm"><thead><tr><th>PV + battery / inverter</th><th class="n">Hybrid extra CAPEX</th><th class="n">Discharged MWh</th><th class="n">Arbitrage yr 1</th><th class="n">NPV vs PV only</th><th class="n">Marginal payback</th></tr></thead><tbody>';
    br.forEach((r) => { bh += '<tr' + (rb && r.kwh === rb.kwh ? ' class="ss-sel"' : '') + '><td>' + fmtN(r.kwp) + ' kWp + ' + fmtN(r.kwh) + ' kWh / ' + fmtN(r.pkw) + ' kW</td><td class="n">' + fmtM(r.capBat) + '</td><td class="n">' + fmtN(r.dis / 1000) + '</td><td class="n">' + fmtM(r.arb) + '</td><td class="n">' + fmtM1(r.dNpvVsPv) + '</td><td class="n">' + (r.margPay === undefined ? '-' : fmtY(r.margPay)) + '</td></tr>'; });
    bh += '</tbody></table></div>';
    bh += '<p class="ss-cap">Peak energy is about ' + fmtN(peakDay.lo) + ' kWh per low-season weekday and ' + fmtN(peakDay.hi) + ' kWh per high-season weekday. The battery cycles up to twice a day (overnight off-peak charge, then a midday recharge between the two peak windows). Value per kWh of battery falls as it grows because the low-season peak/off-peak spread is small and solar already covers part of the morning peak.</p>';
    $('ss-bat').innerHTML = bh;

    // ---- baseline
    let bs = '<div class="ss-two"><div>' + chartBaseline() + legend([['#d8573c', 'Peak'], ['#f2a33a', 'Standard'], ['#2f6db5', 'Off-peak']]) + '</div><div>';
    bs += '<table class="ss-t ss-sm"><thead><tr><th>TOU period</th><th class="n">MWh/yr</th><th class="n">Energy cost (current tariff)</th></tr></thead><tbody>';
    [['Peak', 'p'], ['Standard', 's'], ['Off-peak', 'o']].forEach((x) => { bs += '<tr><td>' + x[0] + '</td><td class="n">' + fmtN(per[x[1]] / 1000) + '</td><td class="n">' + fmtM(cost[x[1]]) + '</td></tr>'; });
    bs += '<tr><td><b>Total</b></td><td class="n"><b>' + fmtN(base.kwh / 1000) + '</b></td><td class="n"><b>' + fmtM(annualBill) + '</b></td></tr>';
    bs += '<tr><td>Demand + network access + basic (approx.)</td><td class="n">-</td><td class="n">' + fmtM(fixedYr) + '</td></tr></tbody></table>';
    bs += '<p class="ss-cap">Billed demand ' + fmtN(minKva) + ' to ' + fmtN(maxKva) + ' kVA over the period. Average load ' + fmtN(base.kwh / 8760) + ' kW.</p></div></div>';
    bs += '<table class="ss-t ss-sm"><thead><tr><th>Charge</th><th>Reduced by PV?</th><th>Reduced by battery?</th><th>Note</th></tr></thead><tbody>' +
      '<tr><td>Standard energy</td><td>Yes, main target</td><td>Little</td><td>Solar hours are mostly standard</td></tr>' +
      '<tr><td>Peak energy</td><td>Partly (08:00-10:00 and early evening)</td><td>Yes</td><td>High-season spread is the arbitrage prize</td></tr>' +
      '<tr><td>Off-peak energy</td><td>No</td><td>Cheapest charging window</td><td>Sets grid-charging cost</td></tr>' +
      '<tr><td>Demand and network access</td><td>Not reliably</td><td>Only if interval data shows short peaks</td><td>NAC is a rolling 12-month maximum. No kVA saving is claimed here</td></tr></tbody></table>';
    $('ss-base').innerHTML = bs;

    // ---- inverter / electrical
    const dcacAct = pkw > 0 ? kwp / pkw : 0; const hyb = (hasBat && S.hybrid) ? S.hybrid : null;
    let ie = '<div class="ss-three"><div><h4>Sizing from the numbers</h4><ul>' +
      '<li>PV array: ' + fmtN(kwp) + ' kWp (' + fmtN(Math.ceil(kwp * 1000 / 620 - 1e-9)) + ' x 620 W panels)</li>' +
      (hasBat ? '<li>DC-coupled hybrid inverter: ' + fmtN(pkw) + ' kW AC for PV and battery together. DC/AC ' + dcacAct.toFixed(2) + (dcacAct > num('i_dcac') + 0.001 ? ' (above the ' + num('i_dcac').toFixed(2) + ' limit, PV will clip)' : '') + '</li>' +
      '<li>Battery: ' + fmtN(kwh) + ' kWh, charge/discharge limited to ' + fmtN(Math.min(pkw, kwh * (1 / Math.max(0.5, num('i_hours') || 2)))) + ' kW</li>' +
      (hyb ? '<li>Costed as ' + hyb.brand + ': ' + hyb.desc + ' (' + fmtM(hyb.sell) + ' client price ex VAT at ' + num('i_gp') + '% GP, installer cost ' + fmtM(hyb.cost) + ')</li>' : '')
      : '<li>PV only: grid-tied string inverters, about ' + fmtN(kwp / 1.2) + ' kVA at DC/AC 1.2 (priced inside the R/Wp rate)</li><li>No battery in the selected case</li>') +
      '<li>Billed maximum demand ' + fmtN(maxKva) + ' kVA is one 30-minute value, not instantaneous load</li>' +
      '<li>Zero-export controller assumed, since no export value is modelled</li></ul></div>';
    ie += '<div><h4>Measurements needed to confirm</h4><ul><li>12 months of 30-minute kW and kVA from the Vivarox check meter</li><li>Power factor at the monthly peak</li><li>Incomer and transformer rating, spare capacity, protection and short-circuit level</li><li>Roof area, orientation, shading, structure</li><li>Municipal embedded-generation approval and any export rule</li></ul></div>';
    ie += '<div><h4>Data limits that move the answer</h4><ul><li>Load shape inside each TOU period is flat until interval data is loaded</li><li>Tariff is an interim billing measure and may change</li><li>No kVA / network access saving is included</li><li>TOU hours and seasons are assumptions (editable in the model file)</li><li>Tax, depreciation and the battery end-of-life value are ignored</li></ul></div></div>';
    $('ss-inv').innerHTML = ie;
  }

  function wire() {
    const sizeIds = ['i_kwp', 'i_kwh', 'i_pkw', 'i_scen'];
    // everything re-computes; assumption changes also re-run the optimiser
    document.querySelectorAll('#ss-root input, #ss-root select').forEach((el) => {
      el.addEventListener('input', () => {
        if (sizeIds.indexOf(el.id) >= 0) { recalc(false); } else { recommended = null; recalc(true); }
      });
    });
    $('ss-reset').addEventListener('click', () => { recommended = null; recalc(true); });
  }

  // Seed the tariff display
  $('ss-tariff').innerHTML = '<table class="ss-t ss-sm"><thead><tr><th>R/kWh excl VAT</th><th class="n">High (Jun-Aug)</th><th class="n">Low (Sep-May)</th></tr></thead><tbody>' +
    '<tr><td>Peak</td><td class="n">' + D.rates.ph.toFixed(4) + '</td><td class="n">' + D.rates.pl.toFixed(4) + '</td></tr>' +
    '<tr><td>Standard</td><td class="n">' + D.rates.sh.toFixed(4) + '</td><td class="n">' + D.rates.sl.toFixed(4) + '</td></tr>' +
    '<tr><td>Off-peak</td><td class="n">' + D.rates.oh.toFixed(4) + '</td><td class="n">' + D.rates.ol.toFixed(4) + '</td></tr>' +
    '<tr><td>Demand (R/kVA)</td><td class="n" colspan="2">' + D.fixed.demand.toFixed(2) + '</td></tr>' +
    '<tr><td>Network access (R/kVA)</td><td class="n" colspan="2">' + D.fixed.nac.toFixed(2) + '</td></tr>' +
    '<tr><td>Basic (R/month)</td><td class="n" colspan="2">' + fmtN(D.fixed.basic, 2) + '</td></tr></tbody></table>';
  wire();
  recalc(true);
})();
