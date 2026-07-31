# HolmStone Utility Management Platform (Prototype)

A working prototype of the billing application described in the project brief, built and
reconciled against real monthly workbooks. The platform now manages **two physical properties**
— City Deep Industrial Park and Wingfield Business Park — each fully isolated in its own SQLite
database file, switchable from a dropdown on the Dashboard, sharing one set of logins. See
"Multi-property architecture" below for how the isolation works, and "Wingfield Business Park"
for that property's own tariff structure and data quirks (its billing formula and source
workbook layout are both different from City Deep's).

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
node server.js    # starts the app on http://localhost:8787 - auto-seeds both properties'
                  # databases on first boot (data/city-deep.db, data/wingfield.db) if empty
```

(`npm run seed` / `npm run seed:wingfield` also exist if you ever want to re-run a property's
importer on its own, without booting the whole server - see "Repo layout" below for where each
one lives.)

Then open http://localhost:8787 and sign in with one of the seeded demo accounts:

| Username | Password     | Role       |
|----------|--------------|------------|
| admin    | admin123     | Administrator |
| billing  | billing123   | Billing User |
| reviewer | reviewer123  | Reviewer/Manager |
| viewer   | viewer123    | Read-only |

**Change these passwords (and rotate `SESSION_SECRET`) before putting this anywhere near the
open internet.**

## Multi-property architecture

Each property in `properties.js` gets its **own physical SQLite database file**
(`data/city-deep.db`, `data/wingfield.db`) — there is no shared table with a `property_id` column
that a missed `WHERE` clause could leak across. A signed-in user's session (`auth.js`) tracks
which property they're currently viewing (`currentProperty`); switching via the Dashboard's
dropdown (`POST /switch-property`) just updates that session field and reloads the page — nothing
about the URL changes. Every request resolves its property's database through Node's
`AsyncLocalStorage` (`server.js`'s `dbContext`), which safely hands each concurrent request the
right database connection without a shared mutable variable that could race under Node's async
request handling.

Logins are the one thing genuinely shared: `data/auth.db` holds the canonical `users` table, so
the same admin/billing/reviewer/viewer accounts work no matter which property is selected (each
property database also carries a mirrored copy of `users`, purely to satisfy that database's own
`audit_log.user_id` foreign key — login itself always checks `auth.db` directly).

Each property's own code and data lives in its own top-level folder — `city-deep/` and
`wingfield/` — rather than everything being interleaved in one flat directory. Only genuinely
shared platform code (`server.js`, `views.js`, `db.js`, `billing.js`, `calc.js`, `pdf.js`,
`properties.js`, etc.) lives at the repo root; see "Repo layout" below.

To add a third property: add an entry to `properties.js`, then build a `<slug>/` folder the same
way `wingfield/` was built from `city-deep/` — copy the pattern (its own `seed_<slug>.js`, its own
`imports/` folder for the extracted workbook JSON), adjust the calc engine if its tariff structure
differs (see `wingfield/calc_wingfield.js` vs the root `calc.js` for how different two properties'
formulas can be), and wire `seedFile` in `properties.js`.

## Repo layout

```
server.js, views.js, db.js, auth.js, billing.js, calc.js, pdf.js,      <- shared platform code
properties.js, municipal_compare.js, shared_seed_users.js, logo_asset.js, solar.js
package.json, render.yaml, README.md, DEPLOY.md

city-deep/
  seed.js                    <- City Deep's importer (node city-deep/seed.js, or npm run seed)
  seed_municipal.js          <- City of Johannesburg municipal-statement importer
  sample_billing_slip_Kimmo_April2026.pdf
  imports/                   <- extracted workbook JSON, one file per month + municipal_statements.json

wingfield/
  seed_wingfield.js          <- Wingfield's importer (node wingfield/seed_wingfield.js, or npm run seed:wingfield)
  seed_wingfield_municipal.js  <- City of Ekurhuleni municipal-statement importer
  calc_wingfield.js          <- Wingfield's own tariff/calc engine (its formulas differ from City Deep's)
  extract_wingfield_municipal.py
  imports/                   <- extracted workbook JSON, one file per month + wingfield_municipal_statements.json

data/                        <- runtime-only: SQLite database files, created on first boot, not committed
public/                      <- static assets (logo, stylesheet), served as-is
```

Bottom line: if a file is specific to one property (its importer, its raw workbook JSON, its own
tariff quirks), it lives inside that property's folder. If it's shared platform code every
property's requests run through, it stays at the root.

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
- Excel import *wizard* (this prototype imports via a one-off script per property, e.g.
  `city-deep/seed.js`, rather than an in-app upload flow).
- CSV/Excel export and consumption-trend charts.

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
"SANSKAR Trading") — these are merged via an explicit alias map in `city-deep/seed.js` so
electricity and water don't create two tenant records for one real tenant.

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

- `extract.py` (run against each uploaded workbook) produced the JSON files under
  `city-deep/imports/` — a faithful structured dump of every tenant block, meter row, and the
  workbook's own cached formula results, used both to seed the database and as the reconciliation
  "ground truth."
- `city-deep/seed.js` is idempotent-per-run (deletes and rebuilds bills each time) and shows
  exactly how historical readings, tariffs and calculations should be imported for any future
  month you want to bring in the same way — re-run `extract.py` against a new workbook and drop
  its output into `city-deep/imports/`.

## Wingfield Business Park

Wingfield's own database (`data/wingfield.db`), tariff engine (`wingfield/calc_wingfield.js`) and
importer (`wingfield/seed_wingfield.js`) are entirely separate from City Deep's — its source
workbooks have a different sheet layout and a genuinely different, simpler tariff structure:

- **Electricity**: a flat monthly basic charge + a capacity charge (R/Amp of the tenant's breaker
  rating) + a single active energy rate per kWh. The source workbook's own Tariff sheet already
  resolves winter/summer into one "Active Tariff" cell each month, which is used as-is rather than
  re-deriving the season split. No stepped blocks, no demand kVA/kVArh charges, no network levy —
  none of those exist in Wingfield's tariff.
- **Water**: usage (R/kL) + sewage (R/kL) on the same reading, same as City Deep.

Seeded with the same 13 months as City Deep (July 2025 - July 2026), extracted by
`extract_wingfield.py` into `wingfield/imports/wingfield_YYYY-MM.json`.

**Bulk/reference meters excluded from tenant billing** (per your confirmation for the electrical
ones, extended to water's equivalent for consistency): `Main Council Meter` and
`Subatation Totals` (electrical), and `Council` (water — its meter serials match the raw Water
sheet's own "Council High/Low flow" and "Council check meter" labels, and its scale, ~R126,000/
month, is clearly bulk supply rather than a tenant). Their raw readings are still imported as
`role='bulk'` meters so nothing is silently dropped — they just never generate a tenant bill.

**Tenant name aliasing** (`TENANT_NAME_ALIASES` in `wingfield/seed_wingfield.js`) — the Electrical Billing
and Water Billing sheets spell a few real tenants differently, confirmed by cross-checking meter
serials/locations rather than guessed: `Card Plus` ↔ `Cards Plus`, `TRSAV` ↔ `TRVSA` (a
transposition typo on one side of the two sheets — which spelling is "correct" isn't determinable
from the data, `TRVSA` was picked arbitrarily but applied consistently), `Common area` ↔
`Common Area/Refinery`, and `Arch International Logistics (Pyt) Ltd` (one month's Electrical
Billing spelling) ↔ `Arch International Logistics` (every other month/sheet).

**Sub-metered credit/recharge lines**: a handful of meters physically sit on one tenant's
distribution board but are billed to a different tenant (e.g. an MTN or Vodacom antenna wired
through another tenant's DB). The source sheet shows this as two rows: a positive charge under
the real payer, and an equal-and-opposite negative line inside the host tenant's own block. This
is detected automatically from the row's own charge polarity (not a hardcoded meter list) and
reproduced as a `sign: -1` line item, mirroring the same convention `calc.js` already uses for
City Deep's solar credit meters.

### Reconciliation results (Wingfield)

Across 313 tenant/period/utility rows (14-15 tenants × 2 utilities × 13 months): **264 match the
workbook's own totals exactly**, **19 are within a few cents** (floating-point accumulation), and
**30 are flagged** — every one attributable to one of two confirmed source-workbook defects, not a
parsing or calculation error on this app's side:

1. **The August 2025 workbook** ("Wingfield Park Aug 2025 Final Rev2.xlsx") has broken/shifted
   formulas across both its Electrical Billing and Water Billing "Total" columns for that one
   month only — electrical totals cache as R0 for nearly every tenant, and water totals are
   short by a consistent factor (confirmed by tracing individual meter rows: the sheet's own
   "sanitation" and "total" columns are actually holding that month's water-usage and sanitation
   Rand amounts one column over from where every other month has them). This app's independently
   computed bill is the only reliable total for that month; the workbook's own cached figure
   should not be trusted for August 2025.
2. **The "Common area" water block, most months from January 2026 onward** — the workbook's own
   totals-row SUM formula doesn't extend down far enough to catch the "Fire Water A"/"Fire Water
   B" meter rows, which were evidently added to the sheet below the original formula's range at
   some point. Confirmed by summing the block's own individual meter rows by hand: they add up to
   this app's computed total, not the workbook's cached one. Off by R400-4,000/month depending on
   how many Fire Water meters had nonzero readings that month.

### Wingfield's municipal invoices (City of Ekurhuleni)

Wingfield's bulk municipal supply is billed by a completely different municipality than City
Deep's (City of Ekurhuleni, not City of Johannesburg), on one combined account (2210755502,
"Refinery Prop Inv") rather than City Deep's 4 separate precinct accounts - property rates,
electricity, water, sewerage and refuse all appear on the one PDF each month. Imported from 13
monthly PDF invoices (June 2025 - June 2026) via `wingfield/extract_wingfield_municipal.py` +
`wingfield/seed_wingfield_municipal.js`, following the same pattern as City Deep's `city-deep/seed_municipal.js` (own
de-dup key, own account-to-site mapping added to `municipal_compare.js`'s `SITE_MAP`, everything
else in that comparison module works unchanged since it already resolves against whichever
property's database is active).

**Electricity is Time-of-Use, not flat-rate.** Wingfield's account is billed on three separate
registers - Off-peak, Standard and Peak - not the single flat energy rate an earlier version of
this pipeline assumed. Each statement's kWh lines are classified by their own rate (Rand per kWh)
rather than by meter-serial tag, since pdftotext's linearised text routinely splits a meter's tag
and its reading across a page break: Off-peak is always the lowest rate, Standard the middle, Peak
the highest, with no overlap seen across any of the 13 months (including the low-season/
high-season tariff-year change each month picks up automatically, since it's the rate itself
driving the sort, not a fixed threshold). This was verified against a reference table the client
independently rebuilt from the same invoices - every month's Off-peak/Standard/Peak quantities and
Rand amounts match exactly.

**Property Rates is extracted and stored but not displayed.** Both Wingfield and City Deep still
capture Property Rates in the database (non-destructive, in case this is ever needed), but the
municipal-accounts page, the municipal PDF, and the "Total Charges"/"Total Bill" figures on both
properties now exclude it - the client's call, since rates are a separate municipal charge rather
than a utility and don't belong in a utility-billing total.

Every one of the 13 months reconciles to the cent against that statement's own "TOTAL CURRENT
LEVY" figure (the current month's own new charges, kept deliberately separate from whatever
arrears/balance-brought-forward the same statement also shows). Two source-PDF quirks worth
knowing about, both reproduced rather than special-cased away:

- **Ekurhuleni's own PDF layout repeats its property-info header and aging-table footer on every
  physical page** of a multi-page statement, with the genuinely new itemised charges sandwiched in
  between - the extractor strips the repeated boilerplate per page before summing each utility
  section, rather than trying to pattern-match every possible label EMM might print.
- **Three of the thirteen statements (Nov 2025, Dec 2025, Jan 2026) carry one-off "INTERIM"/
  "INTERIM REVERSAL" water & sewer adjustment lines** instead of the usual "WATER n kl"/
  "SEWER-BUSINESS n kl" lines (an estimated-reading correction, not a data error), and **Oct 2025
  carries a one-off "FINAL NOTICE" fee** bucketed as Sundry. The extractor sums whatever
  charge-shaped rows fall within each utility's section of the statement rather than only matching
  specific labels, so these are picked up correctly without needing a special case for each one.

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
