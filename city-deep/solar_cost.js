// city-deep/solar_cost.js - the OTHER side of solar billing at City Deep. solar.js (repo root) is
// a REPORTING breakdown of how much of a tenant's already-billed electricity charge came from solar
// vs the municipal grid - no cash changes hands there. This file is about real money: Capital
// Propfund (Pty) Ltd, who owns/operates the on-site solar installation, invoices the property owner
// (Refinery Property Investments Two (Pty) Ltd) every month for the solar energy the site's tenants
// actually used, split by sub-site ("City Deep South", "City Deep North", "City Deep Mini Units").
// HolmStone has already billed tenants for that same solar usage as part of their normal
// electricity charge - but paying Capital Propfund for it is a real additional cost the existing
// Recovery comparison (tenant billing vs the real municipal statement) never accounted for.
// Confirmed by the client 2026-08-11: this should be deducted from "Recovery" for the sections it
// applies to - e.g. if Recovery showed +R100 over-recovered and the solar cost that month was R50,
// the property only actually recovered R50.
//
// South and North map to the Industrial Park Recovery section (Industrial A & B municipal
// accounts); Mini Units maps to the Mini Park section. The Rittle section has no solar installation
// and never appears on these invoices, so it's unaffected - see SECTION_SUB_SITES below, used by
// server.js's currentPropRecoverySections() to decide which sections get a solar deduction at all.
//
// Source: 5 monthly Tax Invoices from Capital Propfund (Pty) Ltd - INV2600 (Feb 2026), INV2657
// (Apr 2026), INV2684 (May 2026), INV2735 (Jun 2026) uploaded 2026-08-11, and INV2756 (Jul 2026)
// uploaded 2026-08-24. Jan 2026, Mar 2026, and everything before Feb 2026 / after Jul 2026 has no
// invoice yet - those months simply get a R0 solar deduction (see solarCostForSection's fallback)
// rather than blocking the whole Recovery page. Each invoice's own period happens to line up with
// exactly one City Deep billing_period's own majority-consumption-month label (e.g. "1-28.02.2026"
// -> billing_periods label '2026-02', confirmed against every period's real start/end dates in the
// DB before wiring this in - see tenant_recovery.js's consumptionMonthLabel for the same convention
// used elsewhere), so matching by label alone is safe here - no date-overlap logic needed, unlike
// the municipal side.
const INVOICES = [
  { invoiceNumber: 'INV2600', invoiceDate: '2026-03-18', periodLabel: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28',
    lines: { south: 168096.02, north: 196156.04, mini: 84670.93 } },
  { invoiceNumber: 'INV2657', invoiceDate: '2026-05-15', periodLabel: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30',
    lines: { south: 118776.81, north: 141904.16, mini: 55822.40 } },
  { invoiceNumber: 'INV2684', invoiceDate: '2026-06-05', periodLabel: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31',
    lines: { south: 130061.13, north: 149344.90, mini: 53604.97 } },
  { invoiceNumber: 'INV2735', invoiceDate: '2026-07-24', periodLabel: '2026-06', startDate: '2026-06-01', endDate: '2026-06-30',
    lines: { south: 157687.13, north: 164401.47, mini: 42082.03 } },
  { invoiceNumber: 'INV2756', invoiceDate: '2026-08-07', periodLabel: '2026-07', startDate: '2026-07-01', endDate: '2026-07-31',
    lines: { south: 194781.07, north: 202714.50, mini: 52060.61 } },
];

// sub_site is one of 'south'/'north'/'mini' (short internal key, not the full "City Deep South"
// label printed on the invoice - nothing outside this file ever needs the full label). Figures are
// excl. VAT throughout, matching every other Rand figure in the Recovery comparison (see
// flat_site_recovery.js/tenant_recovery.js's own header comments on why excl-VAT-both-sides is the
// app-wide convention).
function migrateSolarCost(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS solar_cost_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL,
      invoice_date TEXT NOT NULL,
      sub_site TEXT NOT NULL,
      period_label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      amount_excl_vat REAL NOT NULL,
      UNIQUE(sub_site, period_label)
    );
  `);
}

// Safe to re-run on every boot, same convention as every other import script in this app - keyed by
// (sub_site, period_label), upserted rather than inserted, so re-running after a figure correction
// updates the existing row instead of creating a duplicate.
function run(dbFile = 'city-deep.db') {
  const { open } = require('../db');
  const db = open(dbFile);
  migrateSolarCost(db);
  const stmt = db.prepare(`INSERT INTO solar_cost_invoices (invoice_number, invoice_date, sub_site, period_label, start_date, end_date, amount_excl_vat)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(sub_site, period_label) DO UPDATE SET
      invoice_number=excluded.invoice_number, invoice_date=excluded.invoice_date,
      start_date=excluded.start_date, end_date=excluded.end_date, amount_excl_vat=excluded.amount_excl_vat`);
  let created = 0;
  for (const inv of INVOICES) {
    for (const [subSite, amount] of Object.entries(inv.lines)) {
      const before = db.prepare('SELECT id FROM solar_cost_invoices WHERE sub_site=? AND period_label=?').get(subSite, inv.periodLabel);
      stmt.run(inv.invoiceNumber, inv.invoiceDate, subSite, inv.periodLabel, inv.startDate, inv.endDate, amount);
      if (!before) created++;
    }
  }
  if (created) console.log(`City Deep solar cost import: ${created} invoice line(s) added.`);
  return db;
}

// Which sub-sites feed which Recovery section (see recovery_groups.js's SECTIONS keys) - 'rittle'
// deliberately maps to an empty list, since no solar installation exists on that account.
const SECTION_SUB_SITES = { industrial: ['south', 'north'], mini: ['mini'], rittle: [] };

// Returns a function (periodLabel) => Rand (excl VAT), summing every mapped sub-site's invoice line
// for that label, or 0 if nothing was invoiced yet for that month/section. Built once per section
// (one query) rather than once per row, since a Recovery section only ever needs to resolve this for
// however many months are on the page (currently up to 12).
function solarCostForSection(db, sectionKey) {
  const subSites = SECTION_SUB_SITES[sectionKey] || [];
  if (!subSites.length) return () => 0;
  migrateSolarCost(db);
  const rows = db.prepare(`SELECT period_label, amount_excl_vat FROM solar_cost_invoices WHERE sub_site IN (${subSites.map(() => '?').join(',')})`).all(...subSites);
  const byLabel = {};
  for (const r of rows) byLabel[r.period_label] = (byLabel[r.period_label] || 0) + r.amount_excl_vat;
  return (label) => byLabel[label] || 0;
}

module.exports = { run, solarCostForSection, SECTION_SUB_SITES };
