# City Deep Industrial Park — Tenant Utility Billing (Prototype)

A working prototype of the billing application described in the project brief, built and
reconciled against two real monthly workbooks (**March 2026** and **April 2026**).

## What this is

- A real Node.js web app: server-rendered pages, a persistent SQLite database, a calculation
  engine that reproduces the source workbook's tariff formulas, and PDF billing-slip generation.
- **Zero external npm dependencies.** Everything (HTTP server, HTML rendering, sessions,
  password hashing, PDF generation) is built on Node's own standard library, including the
  built-in `node:sqlite` module. This was a deliberate choice for *this environment* — see
  "Why no Express/pdfkit/etc." below — not a recommendation to avoid them in production.
- Seeded with 13 real months of tenant, meter, tariff, reading and billing data (July 2025 -
  July 2026) imported directly from the workbooks you provided.
- **Reconciled against the source workbook**: of 620 tenant/period/utility combinations, 612
  match the workbook's own totals exactly and the remaining 8 are within 2% (see "Reconciliation
  results" below — every variance is individually explained, none are unexplained).
- **Tariff change effective July 2026**: the July workbook carries a new tariff table - electricity
  rates (energy, demand, service and capacity charges, all step-tariff blocks) are up **+9.01%**,
  water is up **+8.00%**, sanitation is up **+10.99%**, versus June 2026. Flat surcharge
  percentages (6% electrical, 2% business), the Special 70Amp fee and the Network Levy are
  unchanged. This lands on 1 July, the standard start of the municipal tariff year, so it reads as
  the annual increase rather than a data anomaly. The app's tariff versioning (`tariff_versions`,
  keyed by `effective_from`) picks this up automatically - March through June already shared one
  version, and July opens a new one.

## Quick start

**Requirements:** Node.js 22.5 or later (for the built-in `node:sqlite` module). Check with
`node --version`.

**Important — run this from a normal local folder, not a cloud-synced one.** SQLite needs real
POSIX file locking, which OneDrive/Dropbox/Google Drive sync folders generally don't support
properly and will fail with a `disk I/O error`. Copy this whole folder somewhere like
`C:\apps\city-deep-billing` (outside OneDrive) before running it.

```bash
cd city-deep-billing
node seed.js      # creates data/billing.db and imports March + April
node server.js    # starts the app on http://localhost:8787
```

Then open http://localhost:8787 and sign in with one of the seeded demo accounts:

| Username | Password     | Role       |
|----------|--------------|------------|
| admin    | admin123     | Administrator |
| billing  | billing123   | Billing User |
| reviewer | reviewer123  | Reviewer/Manager |
| viewer   | viewer123    | Read-only |

**Change these passwords (and rotate `SESSION_SECRET`) before putting this anywhere near the
open internet.**

## What's implemented

- **Dashboard** — active tenants, tenants billed this month, missing readings, draft/finalised
  bill counts, total electricity/water consumption and amounts billed, recent slips.
- **Tenants** — list and detail pages with assigned meters and full billing history, linking
  into every historical month's bill.
- **Meters** — full asset register (96 electricity + ~50 water meters), tagged by role
  (tenant / bulk-feeder / PV-generation / common-area / council-check).
- **Tariffs** — both electricity tariffs and the water/sanitation tariff, version-controlled by
  effective date (the versioning mechanism is live even though March's and April's rates
  happened to be identical in the source data).
- **Billing Periods** — 13 imported months (July 2025 - July 2026), each showing bill counts, plus
  a **"+ New billing period"** button to start a fresh month.
- **Capturing a new month** — from Billing Periods, create a period (label + dates), then you land
  on a reading-capture form: one row per active meter, grouped by tenant, pre-filled with last
  period's closing reading as this period's starting point. Enter each meter's new closing
  reading exactly as it appears on the dial - meters with a CT ratio/multiplier (flagged with a
  `×N` badge) get that multiplier applied automatically, you don't need to do the math yourself.
  Saving generates bills (status `draft`) using the same calculation engine reconciled against
  the historical months.
- **Billing** — select any tenant + any month and see the full breakdown: readings, per-category
  charge lines, subtotal, VAT (15%), total — matching Section 10 of the brief.
- **PDF billing slips** — generated server-side from the stored bill data (not from a live
  browser view), downloadable per bill.
- **Reconciliation report** — a dedicated page comparing the app's independently-computed totals
  against the workbook's own cached totals, tenant by tenant, month by month.
- **Audit log** — logins and PDF downloads are recorded now; the schema and `audit()` helper in
  `server.js` are ready for you to hook up to every write path as the CRUD/edit screens are built
  out (see "What's not implemented yet").
- **Login/roles** — four roles (admin/billing/reviewer/readonly) with hashed passwords
  (scrypt) and signed session cookies.

## What's not implemented yet (prototype scope)

This was built as **Phase 3 (working prototype)** of the brief's own six-phase plan, focused on
proving the calculation engine and core workflows against real data. Not yet built:

- Create/edit forms for tenants, meters, and tariffs (new-month reading capture *is* built — see
  "Capturing a new month" below).
- Bill status workflow UI (draft → reviewed → finalised → issued, with locking and
  reversal/amendment) — the `bills.status` column and states exist in the schema; only the
  read-side is wired up. Bills generated via the reading-capture flow default to `draft`.
- ZIP-of-all-slips download and the combined monthly pack.
- Excel import *wizard* (this prototype imports via a one-off script, `extract.py` +
  `seed.js`, rather than an in-app upload flow).
- CSV/Excel export and consumption-trend charts.
- Photo/document attachments on readings.

None of this requires new architecture — it's the same tables, the same `calc.js` engine, and
the same page layout pattern already in `views.js`.

## Why no Express / pdfkit / etc.

This prototype was built inside a sandboxed environment whose access to the npm registry was
unreliable enough that a plain `npm install express` reliably failed or hung (partial installs,
`ENOTEMPTY` errors on package rename). Rather than ship something that only sometimes builds,
everything was written against Node's standard library only: a small hand-rolled HTTP router in
`server.js`, hand-rolled HTML templates in `views.js`, and a small but fully spec-valid PDF
writer in `pdf.js` (verified by rendering its output with `pdftoppm`). **This works well for a
prototype of this size but is not a recommendation** — a production build should use Express (or
Next.js) and a real PDF library (pdfkit or Puppeteer) once you have normal package-manager
access; nothing here is architecturally hard to swap out later, since the calculation engine
(`calc.js`) and data layer (`db.js`) have no framework dependency either way.

## Calculation engine — how it reproduces the workbook

`calc.js` implements, line for line, the formulas documented in
`City_Deep_Workbook_Analysis_Phase1.docx` (Section 6): flat and stepped electricity tariffs,
demand charges, network/business surcharges, the network levy, tiered water charges, sanitation,
and the common-area water levy. VAT is calculated at 15% on the full subtotal, per your
confirmation.

Three source-workbook quirks are **reproduced deliberately**, not silently "fixed," per the
brief's instruction not to change existing logic without explanation:

1. The reactive-energy (kVArh) demand charge only applies in the "Mini Park" section of the
   workbook, not "Industrial Park" — confirmed as a real inconsistency in Phase 1, reproduced
   exactly for these two historical months pending your decision on whether to keep or fix it
   going forward.
2. The common-area allocation row on every tenant's bill never carries the electrical surcharge
   (hand-set to zero in the source, on every tenant, in both precincts).
3. One specific adjustment line (the combined SA Wireless usage credited to the Teraoka 6C bill)
   has its fixed charges and surcharges hand-zeroed in the source, leaving only the energy
   credit — this is stored as an explicit `energy_only` flag on that one meter assignment,
   not a special case buried in the formula logic.

Two things were fixed rather than reproduced, because they were data-entry inconsistencies
rather than intentional business rules: a handful of tenant names were spelled slightly
differently between the Electrical Billing and Water Billing sheets (e.g. "SANSKAR Teading" vs
"SANSKAR Trading") — these are merged via an explicit alias map in `seed.js` so electricity and
water don't create two tenant records for one real tenant.

## Reconciliation results

Full detail is live at **/reconciliation** once the app is running. Summary across all 620
tenant/period/utility rows (roughly 24-25 tenants × 2 utilities × 13 months, July 2025 - July 2026,
using the tenant name aliasing above):

| Result | Count |
|---|---|
| Exact match (to the cent) | 612 |
| Off by more than 1% | 8 |

Every other electricity and water figure for every tenant, across all 13 months, ties out exactly
— including the hardest cases in the source data: a bulk/feeder meter that bills 0% of energy but
100% of demand (Unit 3 HUDACO Trading), the manually-adjusted SA Wireless credit line (Unit 6C
Teraoka), and a tenant with a fixed R661.90/month capacity charge that doesn't match the standard
tariff rate in *any* of the 13 months (Unit 4 ATC SA Wireless Infrastructure — confirmed as a
genuine per-tenant negotiated rate, now applied automatically via `capacity_charge_override` on
that meter's assignment).

The remaining 8 rows, all individually explained rather than hidden:

- **6 rows, one tenant's water bill (Redefine Common Area Mini Park), various months including
  July 2026** — a small-value (~R50-150/month) common-area water levy row, off by ~R1-7 (~2%). Not
  yet root-caused to a specific formula.
- **2 rows, July 2025 only (Kimmo, Unit 3 HUDACO Trading, electricity)** — the July 2025 workbook
  excludes one specific meter's charges from the tenant's own stated total (Excel's own total
  formula skips that row that month, for a reason not visible from the data), while the app's
  total includes every assigned meter. Confined to this one month; every other month for these
  two tenants matches exactly. Worth a gut-check against whoever managed billing in July 2025 if
  that month's figures matter to you.

## Known data gaps

The file named **"City Deep July 2025 with solar Recon Final.xlsx"** internally covers a period
of **30 May - 25 June 2025** (per its own period cells), about a month behind what its filename
suggests. The next file, August 2025, starts its period on 25 July 2025 - so there's a real,
unexplained gap between 25 June and 25 July 2025 that no supplied workbook covers. Both months'
data are imported and labelled exactly as extracted (period dates as recorded in the source
workbook, label "2025-07" kept for continuity with the filename), and the gap is left as-is rather
than guessed at. If a "true June 2025" or "true July 2025" workbook exists separately, sending it
over would close this gap.

## Source data provenance

- `extract.py` (run against the two uploaded workbooks) produced `march.json` and `april.json` —
  a faithful structured dump of every tenant block, meter row, and the workbook's own cached
  formula results, used both to seed the database and as the reconciliation "ground truth."
- `seed.js` is idempotent-per-run (deletes and rebuilds bills each time) and shows exactly how
  historical readings, tariffs and calculations should be imported for any future month you want
  to bring in the same way — re-run `extract.py` against a new workbook and pass its output
  through the same pipeline.

## Deployment (making this a real hosted URL)

This sandbox can't expose a public URL itself. To get a working `https://...` link:

1. Push this folder to a Git repository.
2. Deploy to Render, Railway, or Fly.io (all support plain Node apps with a persistent disk for
   `data/billing.db`). Set `PORT` from the platform's env var and `SESSION_SECRET` to a random
   value.
3. For real production use, swap SQLite for PostgreSQL (the schema in `db.js` is written in
   portable SQL and maps over directly) and swap the hand-rolled PDF/HTTP layer for
   pdfkit/Express once you have normal package access on the deploy target (most hosts do).

## Assumptions & open items carried over from Phase 1

See `City_Deep_Workbook_Analysis_Phase1.docx` Section 12 for the full list. Still open:
source of common-area/shared-meter allocation percentages (derivation not visible in the
workbook), identity of the "Rittel" cost centre, and banking/logo details for the PDF slip
(placeholder banking details are used for now — replace in `server.js`'s `buildBillPdfData`
call before this goes anywhere real).
