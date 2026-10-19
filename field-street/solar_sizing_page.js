// solar_sizing_page.js - builds the "Solar Sizing" page for 8 Field Street.
//
// Self-contained on purpose: it carries its own scoped CSS (everything under #ss-root) and inlines
// solar_sizing_model.js + solar_sizing_ui.js, so it depends on nothing in public/style.css and touches
// no other page. It is read-only - the route that serves it (server.js, GET /solar-sizing) only reads
// the billing slips and tariff, and the page never writes anything.
const fs = require('fs');
const path = require('path');

const MODEL_JS = fs.readFileSync(path.join(__dirname, 'solar_sizing_model.js'), 'utf8');
const UI_JS = fs.readFileSync(path.join(__dirname, 'solar_sizing_ui.js'), 'utf8');

const CSS = `
#ss-root{--ink:#1e293b;--mut:#64748b;--line:#e2e8f0;--soft:#f1f5f9;--acc:#b8212f;--ok:#1d7a46;--warn:#a15c00;--warnbg:#fff4e0;font-size:14px;color:var(--ink)}
#ss-root *{box-sizing:border-box}
#ss-root .ss-head h1{font-size:24px;font-weight:700;margin:0}
#ss-root .ss-head p{color:var(--mut);margin:2px 0 0}
#ss-root .ss-note{background:var(--soft);border-left:4px solid #94a3b8;padding:8px 12px;border-radius:3px;margin:12px 0;color:#334155}
#ss-root .ss-grid{display:grid;grid-template-columns:minmax(0,330px) minmax(0,1fr);gap:16px;align-items:start}
@media(max-width:960px){#ss-root .ss-grid{grid-template-columns:minmax(0,1fr)}}
#ss-root .ss-card{background:#fff;border:1px solid var(--line);border-radius:6px;padding:14px;margin-bottom:14px;min-width:0}
#ss-root .ss-card h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:0 0 10px;font-weight:700}
#ss-root .ss-card h3{font-size:16px;margin:0 0 6px}
#ss-root .ss-card h4{font-size:13px;margin:0 0 6px}
#ss-root .ss-reco{border:2px solid var(--acc)}
#ss-root .ss-big{font-size:21px;font-weight:700;margin:0 0 4px}
#ss-root .ss-tag{font-size:10px;font-weight:700;text-transform:uppercase;background:var(--soft);color:var(--mut);padding:1px 6px;border-radius:3px;vertical-align:2px}
#ss-root .ss-f{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#ss-root .ss-f .full{grid-column:1/-1}
#ss-root label{display:block;font-size:12px;font-weight:600;margin-bottom:2px}
#ss-root input,#ss-root select{width:100%;font:inherit;font-size:13px;border:1px solid #cbd5e1;border-radius:4px;padding:5px 7px;background:#f8fafc;color:var(--ink)}
#ss-root .ss-u{position:relative}#ss-root .ss-u input{padding-right:46px}
#ss-root .ss-u i{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-style:normal;font-size:11px;color:var(--mut);pointer-events:none}
#ss-root .ss-btn{background:#0f172a;color:#fff;border:0;border-radius:4px;padding:7px 12px;font-weight:600;cursor:pointer;width:100%;font-size:13px}
#ss-root .ss-chips{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}
@media(max-width:800px){#ss-root .ss-chips{grid-template-columns:repeat(2,minmax(0,1fr))}}
#ss-root .ss-chip{background:var(--soft);border-radius:4px;padding:9px;min-width:0}
#ss-root .ss-chip span{display:block;font-size:11px;text-transform:uppercase;color:var(--mut);letter-spacing:.04em}
#ss-root .ss-chip b{display:block;font-size:16px;margin:1px 0}
#ss-root .ss-chip small{color:var(--mut);font-size:11.5px}
#ss-root .ss-chip.hi{background:var(--acc);color:#fff}#ss-root .ss-chip.hi span,#ss-root .ss-chip.hi small{color:#fff;opacity:.85}
#ss-root table.ss-t{border-collapse:collapse;width:100%;font-size:13px}
#ss-root .ss-t th{background:#e2e8f0;text-align:left;padding:6px 8px;font-size:12px}
#ss-root .ss-t td{border-top:1px solid var(--line);padding:5px 8px;vertical-align:top}
#ss-root .ss-t .n{text-align:right;white-space:nowrap}
#ss-root .ss-t th.star{background:var(--acc);color:#fff}#ss-root .ss-t td.star{background:#fbeeee;font-weight:600}
#ss-root .ss-sm{font-size:12.5px}
#ss-root .ss-sel td{background:#fbeeee;font-weight:600}
#ss-root .ss-scroll{overflow-x:auto;margin-top:8px}
#ss-root .ss-warn{background:var(--warnbg);color:var(--warn);border-left:3px solid var(--warn);padding:7px 10px;margin-top:8px;border-radius:2px}
#ss-root .ss-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){#ss-root .ss-two{grid-template-columns:1fr}}
#ss-root .ss-three{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:900px){#ss-root .ss-three{grid-template-columns:1fr}}
#ss-root .ss-three ul{margin:0;padding-left:18px}#ss-root .ss-three li{margin:3px 0}
#ss-root .ss-fin{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
@media(max-width:1100px){#ss-root .ss-fin{grid-template-columns:repeat(2,minmax(0,1fr))}}
#ss-root .ss-finc{border:1px solid var(--line);border-radius:6px;padding:10px;background:#fff}
#ss-root .ss-finc dl{display:grid;grid-template-columns:1fr auto;gap:3px 8px;margin:0;font-size:12.5px}
#ss-root .ss-finc dd{margin:0;text-align:right;font-weight:600}
#ss-root .ss-cap{color:var(--mut);font-size:12.5px;margin:8px 0 0}
#ss-root .ss-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--mut);font-size:12px;margin-top:2px}
#ss-root .ss-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
#ss-root .ss-cw{margin-top:10px}
#ss-root details summary{cursor:pointer;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}
#ss-root details[open] summary{margin-bottom:10px}
`;

function field(id, label, value, unit, extra = '') {
  return `<div><label for="${id}">${label}</label><div class="ss-u"><input id="${id}" type="number" step="any" value="${value}" ${extra}/>${unit ? `<i>${unit}</i>` : ''}</div></div>`;
}

function render({ layout, esc, user, propertyName, data }) {
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const first = data.months[0], last = data.months[data.months.length - 1];
  const period = first ? `${esc(first.label)} to ${esc(last.label)}` : 'no data';
  const body = `
<div id="ss-root">
<style>${CSS}</style>
<div class="ss-head">
  <h1>Solar PV &amp; BESS Sizing &mdash; ${esc(propertyName)}</h1>
  <p>Optimal PV, battery and inverter configuration from the site's own billed consumption, priced at the latest tariff.</p>
</div>
<div class="ss-note">Standalone model. It reads the tenant billing slips for ${period} and the current tariff${data.tariffName ? ' (' + esc(data.tariffName) + ', effective ' + esc(data.effectiveFrom || '') + ')' : ''}. It does not change any billing data. Edit any input on the left and everything recalculates.</div>
<div class="ss-grid">
<div>
  <div class="ss-card" style="border:2px solid var(--acc)"><h2>Scenario shown below</h2>
    <select id="i_scen"><option value="A">A &nbsp;PV only (grid tied)</option><option value="B">B &nbsp;PV + BESS, solar charging only</option><option value="C">C &nbsp;PV + BESS, solar + grid charging</option></select>
    <div style="margin-top:8px"><button type="button" class="ss-btn" id="ss-reset">Reset to optimiser recommendation</button></div></div>
  <div class="ss-card"><h2>Solar PV</h2><div class="ss-f">
    ${field('i_kwp', 'Size', 750, 'kWp')}
    <div><label for="i_mount">Mounting</label><select id="i_mount"><option value="roof">Roof</option><option value="ground">Ground</option></select></div>
    ${field('i_yield', 'Specific yield', 1550, 'kWh/kWp')}
    ${field('i_dcac', 'Max DC/AC (hybrid)', 1.5, '')}
    ${field('i_rroof', 'Roof sell price', 9, 'R/Wp')}
    ${field('i_rground', 'Ground sell price', 12, 'R/Wp')}
    ${field('i_degpv', 'PV degradation', 0.5, '%/yr')}
    ${field('i_pvlife', 'PV life', 20, 'yr')}
  </div></div>
  <div class="ss-card"><h2>Battery</h2><div class="ss-f">
    ${field('i_kwh', 'Energy', 700, 'kWh')}
    ${field('i_pkw', 'Hybrid inverter (AC)', 500, 'kW')}
    ${field('i_gp', 'Hybrid GP (client price)', 25, '%')}
    <div><label for="i_brand">Hybrid brand</label><select id="i_brand"><option value="auto">Cheapest of Sigenergy / Solis</option><option value="sigen">Sigenergy</option><option value="solis">Solis</option></select></div>
    ${field('i_dod', 'Usable (DoD)', 90, '%')}
    ${field('i_eff', 'Round-trip efficiency', 90, '%')}
    ${field('i_degbat', 'Degradation', 2, '%/yr')}
    ${field('i_batlife', 'Battery life', 15, 'yr')}
    ${field('i_hours', 'Battery C-rate limit (hours)', 2, 'h')}
  </div></div>
  <div class="ss-card"><h2>Economics &amp; finance</h2><div class="ss-f">
    ${field('i_esc', 'Tariff escalation', 8.8, '%/yr')}
    ${field('i_maint', 'Maintenance', 1, '% capex')}
    ${field('i_ins', 'Insurance', 1, '% capex')}
    ${field('i_mesc', 'Maint. escalation', 6, '%/yr')}
    ${field('i_prime', 'Prime rate', 10.5, '%')}
    ${field('i_spread', 'PPA spread over prime', 2, '%')}
    ${field('i_disc', 'Discount rate (blank = prime + spread)', '', '%', 'placeholder="auto"')}
    ${field('i_loan', 'Loan term', 10, 'yr')}
    ${field('i_ppaesc', 'PPA escalation', 8.8, '%/yr')}
  </div></div>
  <div class="ss-card"><h2>Optimiser hurdles</h2><div class="ss-f">
    ${field('i_hurdlepv', 'PV: max marginal payback', 3.5, 'yr')}
    ${field('i_hurdlebat', 'Battery: max marginal payback', 4, 'yr')}
  </div><p class="ss-cap">Each step up in size is accepted while the extra CAPEX still pays back within the hurdle.</p></div>
  <div class="ss-card"><details><summary>Tariff in use</summary><div id="ss-tariff"></div><p class="ss-cap">Pulled from this site's Tariff tab (latest version). Interim billing measure; may change.</p></details></div>
</div>
<div id="ss-out">
  <div class="ss-card ss-reco" id="ss-reco"></div>
  <div class="ss-card"><h2>Selected scenario</h2><div class="ss-chips" id="ss-chips"></div></div>
  <div class="ss-card"><h2>Scenario comparison</h2><div class="ss-scroll" id="ss-scen"></div></div>
  <div class="ss-card"><h2>Finance routes</h2><div id="ss-fin"></div></div>
  <div class="ss-card"><h2>PV size optimiser</h2><div id="ss-pv"></div></div>
  <div class="ss-card"><h2>Battery optimiser</h2><div id="ss-bat"></div></div>
  <div class="ss-card"><h2>Baseline account</h2><div id="ss-base"></div></div>
  <div class="ss-card"><h2>Inverter, electrical design and data limits</h2><div id="ss-inv"></div></div>
</div>
</div>
<script>window.SS_DATA=${safeJson};</script>
<script>${MODEL_JS}</script>
<script>${UI_JS}</script>
</div>`;
  return layout({ title: 'Solar Sizing', user, active: '/solar-sizing', body });
}

module.exports = { render };
