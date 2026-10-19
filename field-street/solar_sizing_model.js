// solar_sizing_model.js - Solar PV + BESS sizing and finance model for 8 Field Street.
//
// Plain JavaScript with no dependencies: it runs unchanged in the browser (the Solar Sizing page
// inlines it, so every input edit recomputes instantly) and in Node (for testing).
//
// What it does, in order:
//   1. Builds a full-year hourly load profile from the site's own monthly billed Peak / Standard /
//      Off-peak kWh (tenant billing slips, NOT municipal statements) - each month's period energy is
//      spread evenly over that month's hours in that TOU period.
//   2. Builds an hourly PV profile (per kWp) scaled to the specific yield (default 1,550 kWh/kWp/yr).
//   3. Simulates the year hour by hour for PV only, and PV + battery (solar charging, and optionally
//      off-peak / midday-standard grid charging when the tariff spread justifies it).
//   4. Prices the result at the CURRENT tariff, then runs the cash / financed / PPA finance routes.
//
// Assumptions that matter (all shown on the page):
//   - TOU hours: weekday peak 07-10 and 18-20, standard 06-07, 10-18, 20-22; Saturday standard
//     07-12 and 18-20; everything else off-peak. High season Jun-Aug. (Edit TOU below to change.)
//   - No export value: surplus PV beyond the load is spilled, the battery never exports.
//   - No billed-kVA saving is claimed (needs the half-hourly interval data to prove).
//   - Hourly load SHAPE inside a TOU period is flat until interval data is loaded.
(function (root) {
  'use strict';

  const YEAR = 2026; // non-leap, 8,760 h; only used for the weekday/weekend pattern
  const HIGH = { 6: true, 7: true, 8: true };
  // Sunrise hour and relative daily yield by month (Gauteng-like), normalised to the chosen yield.
  const SUNR = { 1: 5.4, 2: 5.8, 3: 6.1, 4: 6.4, 5: 6.7, 6: 6.9, 7: 6.9, 8: 6.6, 9: 6.1, 10: 5.6, 11: 5.2, 12: 5.1 };
  const DAYYLD = { 1: 5.0, 2: 4.9, 3: 4.5, 4: 4.2, 5: 3.9, 6: 3.6, 7: 3.8, 8: 4.3, 9: 4.9, 10: 5.2, 11: 5.2, 12: 5.2 };

  // Weekday 0 = Monday ... 6 = Sunday.
  function period(wd, h) {
    if (wd < 5) {
      if ((h >= 7 && h < 10) || (h >= 18 && h < 20)) return 'p';
      if (h === 6 || (h >= 10 && h < 18) || (h >= 20 && h < 22)) return 's';
      return 'o';
    }
    if (wd === 5) return ((h >= 7 && h < 12) || (h >= 18 && h < 20)) ? 's' : 'o';
    return 'o';
  }

  // Calendar skeleton, built once.
  const CAL = (function () {
    const mdays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const month = [], wd = [], hour = [], per = [];
    let dayIdx = 0;
    const jan1 = new Date(Date.UTC(YEAR, 0, 1)).getUTCDay(); // 0=Sun
    const jan1Mon0 = (jan1 + 6) % 7;
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= mdays[m - 1]; d++) {
        const w = (jan1Mon0 + dayIdx) % 7;
        for (let h = 0; h < 24; h++) { month.push(m); wd.push(w); hour.push(h); per.push(period(w, h)); }
        dayIdx++;
      }
    }
    return { month, wd, hour, per, n: month.length };
  })();

  // data.months: [{m:1..12, p, s, o, kva}] - kWh per TOU period for that calendar month.
  function buildLoad(months) {
    const byM = {};
    months.forEach((x) => { byM[x.m] = x; });
    const cnt = {};
    for (let i = 0; i < CAL.n; i++) { const k = CAL.month[i] + CAL.per[i]; cnt[k] = (cnt[k] || 0) + 1; }
    const load = new Float64Array(CAL.n);
    for (let i = 0; i < CAL.n; i++) {
      const x = byM[CAL.month[i]]; if (!x) continue;
      const e = x[CAL.per[i]];
      load[i] = e / cnt[CAL.month[i] + CAL.per[i]];
    }
    return load;
  }

  function buildPv(yieldKwhKwp) {
    let tot = 0;
    for (let i = 0; i < CAL.n; i++) if (CAL.hour[i] === 0) tot += DAYYLD[CAL.month[i]];
    const scale = yieldKwhKwp / tot;
    const pv = new Float64Array(CAL.n);
    let i = 0;
    while (i < CAL.n) {
      const m = CAL.month[i]; const sr = SUNR[m]; const ss = 24 - sr;
      let sum = 0; const day = new Float64Array(24);
      for (let h = 0; h < 24; h++) {
        const t = h + 0.5;
        day[h] = (t <= sr || t >= ss) ? 0 : Math.pow(Math.sin(Math.PI * (t - sr) / (ss - sr)), 1.25);
        sum += day[h];
      }
      for (let h = 0; h < 24; h++) pv[i + h] = sum > 0 ? day[h] / sum * DAYYLD[m] * scale : 0;
      i += 24;
    }
    return pv;
  }

  // rates: {ph, pl, sh, sl, oh, ol} R/kWh. opts: {kwp, kwh, pkw, gridCharge, eff, dod, exportRate}
  function simulate(ctx, kwp, kwh, pkw, gridCharge, eff, dod) {
    const { load, pvk, rates } = ctx;
    let pvGen = 0, pvUsed = 0, spill = 0, savingPv = 0;
    const byMonthPv = new Float64Array(13);
    for (let i = 0; i < CAL.n; i++) {
      const hi = !!HIGH[CAL.month[i]];
      const r = hi ? { p: rates.ph, s: rates.sh, o: rates.oh } : { p: rates.pl, s: rates.sl, o: rates.ol };
      const g = pvk[i] * kwp;
      const u = Math.min(g, load[i]);
      pvGen += g; pvUsed += u; spill += g - u; savingPv += u * r[CAL.per[i]];
      byMonthPv[CAL.month[i]] += u * r[CAL.per[i]];
    }
    const out = { pvGen, pvUsed, spill, savingPv, arb: 0, dis: 0, chGrid: 0, chPv: 0, arbHigh: 0, arbLow: 0, disHigh: 0, disLow: 0 };
    if (!(kwh > 0) || !(pkw > 0)) return out;
    const usable = kwh * dod;
    let soc = 0;
    for (let i = 0; i < CAL.n; i++) {
      const hi = !!HIGH[CAL.month[i]];
      const pr = hi ? rates.ph : rates.pl, orate = hi ? rates.oh : rates.ol, srate = hi ? rates.sh : rates.sl;
      const per = CAL.per[i];
      const g = pvk[i] * kwp;
      const surplus = Math.max(0, g - load[i]);
      const loadNet = Math.max(0, load[i] - g);
      if (per === 'p') {
        const d = Math.min(pkw, loadNet, soc);
        soc -= d; out.dis += d; out.arb += d * pr;
        if (hi) { out.arbHigh += d * pr; out.disHigh += d; } else { out.arbLow += d * pr; out.disLow += d; }
      } else {
        let room = usable - soc;
        const c = Math.min(surplus, pkw, room);
        soc += c; out.chPv += c; room -= c;
        if (gridCharge && room > 1e-9) {
          const costIn = per === 'o' ? orate : (per === 's' ? srate : 1e9);
          const margin = pr - costIn / eff;
          if (margin > 0.6) {
            const wd = CAL.wd[i], h = CAL.hour[i];
            const ok = (per === 'o' && (wd === 6 || wd <= 3) && h >= 22) ||
                       (per === 'o' && wd <= 4 && h < 6) ||
                       (per === 's' && wd < 5 && h >= 10 && h < 18);
            if (ok) {
              const cg = Math.min(pkw, room);
              soc += cg; out.chGrid += cg;
              const cost = cg * costIn / eff;
              out.arb -= cost;
              if (hi) out.arbHigh -= cost; else out.arbLow -= cost;
            }
          }
        }
      }
    }
    return out;
  }

  function irr(cfs) {
    const f = (r) => { let s = 0; for (let i = 0; i < cfs.length; i++) s += cfs[i] / Math.pow(1 + r, i); return s; };
    let lo = -0.9, hi = 10;
    if (f(lo) * f(hi) > 0) return null;
    for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; }
    return (lo + hi) / 2;
  }

  // Annual operating flows over the PV life; the battery contributes only inside its own life.
  function flows(a, capPv, capBat, svPv, svBat) {
    const out = [];
    for (let y = 1; y <= a.pvLife; y++) {
      let s = svPv * Math.pow(1 - a.degPv, y - 1) * Math.pow(1 + a.esc, y - 1);
      let om = capPv * a.maint * Math.pow(1 + a.maintEsc, y - 1) + capPv * a.ins;
      if (capBat > 0 && y <= a.batLife) {
        s += svBat * Math.pow(1 - a.degBat, y - 1) * Math.pow(1 + a.esc, y - 1);
        om += capBat * a.maint * Math.pow(1 + a.maintEsc, y - 1) + capBat * a.ins;
      }
      out.push({ s, om });
    }
    return out;
  }

  function cash(a, capPv, capBat, svPv, svBat) {
    const fl = flows(a, capPv, capBat, svPv, svBat); const cap = capPv + capBat;
    const net = fl.map((x) => x.s - x.om);
    let cum = -cap, pay = null, dcum = -cap, dpay = null, npv = -cap;
    const cumSeries = [-cap];
    net.forEach((c, i) => {
      const y = i + 1; const prev = cum; cum += c;
      if (pay === null && cum >= 0) pay = y - 1 + (-prev / c);
      const dc = c / Math.pow(1 + a.disc, y); const pd = dcum; dcum += dc; npv += dc;
      if (dpay === null && dcum >= 0) dpay = y - 1 + (-pd / dc);
      cumSeries.push(cum);
    });
    return { cap, y1Gross: fl[0].s, y1Net: net[0], pay, dpay, npv, irr: irr([-cap].concat(net)), net, cum: cumSeries, total: net.reduce((x, y) => x + y, 0) };
  }

  function financed(a, capPv, capBat, svPv, svBat) {
    const fl = flows(a, capPv, capBat, svPv, svBat); const cap = capPv + capBat;
    const n = a.loanTerm, r = a.prime;
    const pmt = r === 0 ? cap / n : cap * r / (1 - Math.pow(1 + r, -n));
    const net = fl.map((x, i) => x.s - x.om - (i + 1 <= n ? pmt : 0));
    let npv = 0, cum = 0, pos = null; const cumSeries = [0];
    net.forEach((c, i) => { npv += c / Math.pow(1 + a.disc, i + 1); cum += c; if (pos === null && cum >= 0) pos = i + 1; cumSeries.push(cum); });
    return { pmt, y1Net: net[0], npv, cumPos: pos, interest: pmt * n - cap, net, cum: cumSeries };
  }

  // PPA: the investor funds the CAPEX and the O&M and must earn a = prime + spread. Solve the starting
  // R/kWh (escalating at ppaEsc) on every kWh delivered (PV used + battery discharged) so the investor's
  // NPV at that rate is zero. Also reports what the client keeps.
  function ppa(a, capPv, capBat, svPv, svBat, kwhPv, kwhBat, ppaEsc) {
    const fl = flows(a, capPv, capBat, svPv, svBat); const cap = capPv + capBat; const ir = a.prime + a.ppaSpread;
    const kwh = [];
    for (let y = 1; y <= a.pvLife; y++) {
      let k = kwhPv * Math.pow(1 - a.degPv, y - 1);
      if (capBat > 0 && y <= a.batLife) k += kwhBat * Math.pow(1 - a.degBat, y - 1);
      kwh.push(k);
    }
    let A = 0, B = 0;
    for (let y = 1; y <= a.pvLife; y++) {
      A += kwh[y - 1] * Math.pow(1 + ppaEsc, y - 1) / Math.pow(1 + ir, y);
      B += fl[y - 1].om / Math.pow(1 + ir, y);
    }
    const p0 = (cap + B) / A;
    const client = fl.map((x, i) => x.s - p0 * Math.pow(1 + ppaEsc, i) * kwh[i]);
    let cnpv = 0, ctot = 0;
    client.forEach((c, i) => { cnpv += c / Math.pow(1 + a.disc, i + 1); ctot += c; });
    return { p0, ir, y1Client: client[0], clientNpv: cnpv, clientTotal: ctot, kwh1: kwh[0], client };
  }

  // ---- public API ------------------------------------------------------------------------------
  function makeContext(site, assum) {
    return { load: buildLoad(site.months), pvk: buildPv(assum.yield), rates: site.rates, site, yield: assum.yield };
  }

  function capexOf(a, kwp, kwh) {
    return { pv: kwp * 1000 * (a.mount === 'ground' ? a.rateGround : a.rateRoof), bat: kwh * 1000 * a.rateBat };
  }

  // One scenario evaluation. kind: 'base' | 'A' (PV only) | 'B' (solar-charge battery) | 'C' (solar + grid charging)
  function evaluate(ctx, a, kind, kwp, kwh, pkw) {
    const gridCharge = kind === 'C';
    const useBat = (kind === 'B' || kind === 'C') && kwh > 0;
    const useKwp = kind === 'base' ? 0 : kwp;
    const sim = simulate(ctx, useKwp, useBat ? kwh : 0, useBat ? pkw : 0, gridCharge, a.eff, a.dod);
    const cx = capexOf(a, useKwp, useBat ? kwh : 0);
    const res = { kind, kwp: useKwp, kwh: useBat ? kwh : 0, pkw: useBat ? pkw : 0, capPv: cx.pv, capBat: cx.bat, capex: cx.pv + cx.bat, sim };
    if (kind === 'base') return res;
    res.cash = cash(a, cx.pv, cx.bat, sim.savingPv, sim.arb);
    res.fin = financed(a, cx.pv, cx.bat, sim.savingPv, sim.arb);
    res.ppa = ppa(a, cx.pv, cx.bat, sim.savingPv, sim.arb, sim.pvUsed, sim.dis, a.ppaEsc);
    res.ppaFlat = ppa(a, cx.pv, cx.bat, sim.savingPv, sim.arb, sim.pvUsed, sim.dis, 0);
    res.avoided = (sim.savingPv + sim.arb) / Math.max(1, sim.pvUsed + sim.dis);
    return res;
  }

  // Baseline annual energy and cost at the current tariff.
  function baseline(ctx) {
    const { load, rates } = ctx; let kwh = 0, cost = 0; const per = { p: 0, s: 0, o: 0 }; const costPer = { p: 0, s: 0, o: 0 };
    for (let i = 0; i < CAL.n; i++) {
      const hi = !!HIGH[CAL.month[i]];
      const r = hi ? { p: rates.ph, s: rates.sh, o: rates.oh } : { p: rates.pl, s: rates.sl, o: rates.ol };
      kwh += load[i]; per[CAL.per[i]] += load[i]; const c = load[i] * r[CAL.per[i]]; cost += c; costPer[CAL.per[i]] += c;
    }
    return { kwh, energyCost: cost, per, costPer };
  }

  // PV size sweep: marginal saving, marginal payback, NPV for each size.
  function sweepPv(ctx, a, sizes) {
    const rows = []; let prev = null;
    sizes.forEach((k) => {
      const e = evaluate(ctx, a, 'A', k, 0, 0);
      const row = { kwp: k, capex: e.capex, saving: e.sim.savingPv, used: e.sim.pvUsed, gen: e.sim.pvGen, npv: e.cash.npv, pay: e.cash.pay, irr: e.cash.irr };
      if (prev) { row.dCap = row.capex - prev.capex; row.dSave = row.saving - prev.saving; row.margPay = row.dSave > 0 ? row.dCap / row.dSave : Infinity; row.dNpv = row.npv - prev.npv; }
      rows.push(row); prev = row;
    });
    return rows;
  }

  // Battery sweep at a fixed PV size. pkw = kwh / hoursRating (default 2 h rating, i.e. 0.5C).
  function sweepBat(ctx, a, kwp, sizes, hoursRating, kind) {
    const rows = []; let prev = null;
    const k0 = evaluate(ctx, a, 'A', kwp, 0, 0);
    sizes.forEach((E) => {
      const e = evaluate(ctx, a, kind || 'C', kwp, E, E / hoursRating);
      const row = { kwh: E, pkw: E / hoursRating, capBat: e.capBat, arb: e.sim.arb, dis: e.sim.dis, npv: e.cash.npv, pay: e.cash.pay, dNpvVsPv: e.cash.npv - k0.cash.npv };
      if (prev) { row.dCap = row.capBat - prev.capBat; row.dArb = row.arb - prev.arb; row.margPay = row.dArb > 0 ? row.dCap / row.dArb : Infinity; }
      rows.push(row); prev = row;
    });
    return rows;
  }

  // Pick the largest size whose marginal payback is still within the hurdle.
  function pickPv(rows, hurdle) {
    let best = rows[0];
    for (let i = 1; i < rows.length; i++) { if (rows[i].margPay <= hurdle) best = rows[i]; else break; }
    return best;
  }
  function pickBat(rows, hurdle) {
    let best = null;
    for (let i = 0; i < rows.length; i++) {
      if (i === 0) { if (rows[0].pay !== null && (rows[0].margPay === undefined) && (rows[0].capBat / Math.max(1, rows[0].arb)) <= hurdle) best = rows[0]; continue; }
      const mp = rows[i].margPay;
      if (mp <= hurdle && best !== null) best = rows[i];
      else if (mp <= hurdle && best === null) best = rows[i];
      else break;
    }
    return best || rows[0];
  }

  const api = { CAL, HIGH, makeContext, evaluate, baseline, sweepPv, sweepBat, pickPv, pickBat, capexOf, simulate, flows, cash, financed, ppa, irr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SolarSizing = api;
})(typeof window !== 'undefined' ? window : globalThis);
