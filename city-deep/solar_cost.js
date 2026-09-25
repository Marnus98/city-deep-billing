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
// Source: 6 monthly Tax Invoices from Capital Propfund (Pty) Ltd - INV2600 (Feb 2026), INV2657
// (Apr 2026), INV2684 (May 2026), INV2735 (Jun 2026) uploaded 2026-08-11, INV2756 (Jul 2026)
// uploaded 2026-08-24, and INV2788 (Aug 2026) uploaded 2026-09-15. Jan 2026, Mar 2026, and
// everything before Feb 2026 / after Aug 2026 has no invoice yet - those months simply get a R0
// solar deduction (see solarCostForSection's fallback) rather than blocking the whole Recovery
// page. Each invoice's own period happens to line up with
// exactly one City Deep billing_period's own majority-consumption-month label (e.g. "1-28.02.2026"
// -> billing_periods label '2026-02', confirmed against every period's real start/end dates in the
// DB before wiring this in - see tenant_recovery.js's consumptionMonthLabel for the same convention
// used elsewhere), so matching by label alone is safe here - no date-overlap logic needed, unlike
// the municipal side.
//
// kWh figures added 2026-09-25 (client request, so Recovery reflects over/under-recovery "as
// accurate as possible" in consumption terms too, not just Rand): each Fortress/Capital Propfund
// invoice is backed by a per-sub-site "Report Data" workbook (PV Production / Bulk Check for
// Export / TOU sheets) whose Summary tab breaks the invoice into Production kWh (what the plant
// generated, billed to the property) and Export kWh (what was fed back to the grid, credited back
// at the same invoice). productionKwh - exportKwh is the net kWh the plant actually delivered
// on-site that HolmStone's tenants were billed for (via their normal electricity charge, same as
// solar.js's existing Rand-vs-source breakdown) but that never passed through the municipal meter -
// so it's the kWh-side counterpart to the amount_excl_vat Rand deduction already netted into
// elecRand. Confirmed each workbook's own "Total Due" cell matches the amount already hard-coded
// below to the cent (e.g. Mini Aug26: R73,829.8624668 in both), so the two sources agree and the
// productionKwh/exportKwh figures are safe to trust.
const INVOICES = [
  { invoiceNumber: 'INV2600', invoiceDate: '2026-03-18', periodLabel: '2026-02', startDate: '2026-02-01', endDate: '2026-02-28',
    lines: { south: { amount: 168096.02 }, north: { amount: 196156.04 }, mini: { amount: 84670.93 } } },
  { invoiceNumber: 'INV2657', invoiceDate: '2026-05-15', periodLabel: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30',
    lines: {
      south: { amount: 118776.81, productionKwh: 65737.38, exportKwh: 14000.92 },
      north: { amount: 141904.16, productionKwh: 64477.30, exportKwh: 1131.03 },
      mini: { amount: 55822.40, productionKwh: 30761.09, exportKwh: 6406.96 },
    } },
  { invoiceNumber: 'INV2684', invoiceDate: '2026-06-05', periodLabel: '2026-05', startDate: '2026-05-01', endDate: '2026-05-31',
    lines: {
      south: { amount: 130061.13, productionKwh: 69188.83, exportKwh: 10413.04 },
      north: { amount: 149344.90, productionKwh: 68104.27, exportKwh: 111.15 },
      mini: { amount: 53604.97, productionKwh: 27279.43, exportKwh: 3473.55 },
    } },
  { invoiceNumber: 'INV2735', invoiceDate: '2026-07-24', periodLabel: '2026-06', startDate: '2026-06-01', endDate: '2026-06-30',
    lines: {
      south: { amount: 157687.13, productionKwh: 53619.46, exportKwh: 4717.30 },
      north: { amount: 164401.47, productionKwh: 52980.69, exportKwh: 395.21 },
      mini: { amount: 42082.03, productionKwh: 13248.25, exportKwh: 69.47 },
    } },
  { invoiceNumber: 'INV2756', invoiceDate: '2026-08-07', periodLabel: '2026-07', startDate: '2026-07-01', endDate: '2026-07-31',
    lines: {
      south: { amount: 194781.07, productionKwh: 60517.82, exportKwh: 3801.40 },
      north: { amount: 202714.50, productionKwh: 60648.06, exportKwh: 0 },
      mini: { amount: 52060.61, productionKwh: 15362.31, exportKwh: 180.18 },
    } },
  { invoiceNumber: 'INV2788', invoiceDate: '2026-09-14', periodLabel: '2026-08', startDate: '2026-08-01', endDate: '2026-08-31',
    lines: {
      south: { amount: 216422.12, productionKwh: 71750.82, exportKwh: 8621.33 },
      north: { amount: 225659.92, productionKwh: 70635.16, exportKwh: 3052.35 },
      mini: { amount: 73829.86, productionKwh: 23483.26, exportKwh: 1545.07 },
    } },
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
  // Added 2026-09-25: production_kwh/export_kwh back up amount_excl_vat from the Fortress "Report
  // Data" workbooks (see INVOICES comment above). NULL for the one invoice (Feb 2026) whose workbook
  // wasn't supplied, so solarKwhForSection below simply nets 0 kWh for that month - the existing R
  // deduction for Feb is untouched either way.
  const cols = db.prepare("PRAGMA table_info(solar_cost_invoices)").all().map((c) => c.name);
  if (!cols.includes('production_kwh')) db.exec('ALTER TABLE solar_cost_invoices ADD COLUMN production_kwh REAL');
  if (!cols.includes('export_kwh')) db.exec('ALTER TABLE solar_cost_invoices ADD COLUMN export_kwh REAL');
}

// Safe to re-run on every boot, same convention as every other import script in this app - keyed by
// (sub_site, period_label), upserted rather than inserted, so re-running after a figure correction
// updates the existing row instead of creating a duplicate.
function run(dbFile = 'city-deep.db') {
  const { open } = require('../db');
  const db = open(dbFile);
  migrateSolarCost(db);
  const stmt = db.prepare(`INSERT INTO solar_cost_invoices (invoice_number, invoice_date, sub_site, period_label, start_date, end_date, amount_excl_vat, production_kwh, export_kwh)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sub_site, period_label) DO UPDATE SET
      invoice_number=excluded.invoice_number, invoice_date=excluded.invoice_date,
      start_date=excluded.start_date, end_date=excluded.end_date, amount_excl_vat=excluded.amount_excl_vat,
      production_kwh=excluded.production_kwh, export_kwh=excluded.export_kwh`);
  let created = 0;
  for (const inv of INVOICES) {
    for (const [subSite, line] of Object.entries(inv.lines)) {
      const before = db.prepare('SELECT id FROM solar_cost_invoices WHERE sub_site=? AND period_label=?').get(subSite, inv.periodLabel);
      stmt.run(inv.invoiceNumber, inv.invoiceDate, subSite, inv.periodLabel, inv.startDate, inv.endDate, line.amount,
        line.productionKwh != null ? line.productionKwh : null, line.exportKwh != null ? line.exportKwh : null);
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

// Same idea as solarCostForSection but for kWh: returns a function (periodLabel) => net kWh
// (production - export, summed across the section's sub-sites), or 0 if no workbook was supplied
// for that month/sub-site (production_kwh IS NULL, e.g. Feb 2026's INV2600). See the INVOICES
// comment above for why production-minus-export is the right quantity to net against tenant-billed
// elecKwh - it's the kWh counterpart of the amount_excl_vat Rand deduction.
function solarKwhForSection(db, sectionKey) {
  const subSites = SECTION_SUB_SITES[sectionKey] || [];
  if (!subSites.length) return () => 0;
  migrateSolarCost(db);
  const rows = db.prepare(`SELECT period_label, production_kwh, export_kwh FROM solar_cost_invoices WHERE sub_site IN (${subSites.map(() => '?').join(',')})`).all(...subSites);
  const byLabel = {};
  for (const r of rows) {
    if (r.production_kwh == null) continue;
    const net = r.production_kwh - (r.export_kwh || 0);
    byLabel[r.period_label] = (byLabel[r.period_label] || 0) + net;
  }
  return (label) => byLabel[label] || 0;
}

module.exports = { run, solarCostForSection, solarKwhForSection, SECTION_SUB_SITES };
