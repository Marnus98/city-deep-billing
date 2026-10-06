# HolmStone Utility Management Platform - handoff notes

Written 2026-10-06 so any new Claude session (Cowork or Claude Code) can pick up without the old chat.

## What it is
Hand-rolled Node.js billing app (zero npm dependencies, `node:sqlite`) for South African property manager Marnus (marsteyn10@gmail.com). Deployed on Render from the GitHub repo. This folder is the repo.

## Structure
- One SQLite file per property in `data/*.db` (physical isolation), shared logins in `data/auth.db`. Properties are registered in `properties.js`.
- Two billing models:
  - **Tenant-billed** (City Deep, Wingfield): tenants, meters, billing_periods, bills, bill_line_items. Engine: `calc.js`, `billing.js`, `solar.js`.
  - **flat_site** (8 Field Street, Bob Martin, Cranbrook, AutoZone, Loper Road, the 5 Loper Ave sites, A-Shack, RS-Farm sites): `site_tariffs`, `site_tariff_items`, `site_billing_slips`, `site_slip_readings`. Engine: `calc_flat_site.js`. Tariff shapes: `flat_site_tariff_shapes.js`. Seeding helpers: `flat_site_seed_helpers.js`. Each site has its own `import_history.js` / `municipal_import.js`.
- PDFs are built by a hand-rolled writer in `pdf.js`. Views in `views.js`, routes in `server.js`.
- Monthly recharge CSV (BEV/Lisa) for the client's accounting system: `recharge_export.js`.

## Conventions to keep
- Safe-to-re-run seeds/imports on every boot (upsert, never duplicate).
- "Going forward only": corrections apply to a NEW tariff version, never rewrite historical slips.
- Production DB on Render is NOT reachable from the sandbox; `data/*.db` here are local seed copies. Fixes for slips the user entered live are done via idempotent "repoint" blocks in the site's `import_history.js`.
- If a column is added to a table that `rebuildFactorTypeCheck()` in `db.js` rebuilds, add it to `REBUILD_DDL` too.
- Same-name multi-unit tenants that the client codes separately must use `tenant_by_id_name` / `excludeUnits` in `recharge_export.js` (Agrana Unit 5, Sanskar Unit 3 vs 9, Uber Nutrition 6+7 vs 9).
- All Rand figures excl. VAT in reports.
- Git: commit locally; the user runs `git push origin main` himself unless credentials are available.

## Recent work (Sept-Oct 2026)
- Loper Ave sites (ADH, Zelvio, Interoll, RCL, Colorobbia): Capacity Charge cost = reading x rate x 3 (`multiplier` column); Capacity reading fixed per site (breaker amps 80/150/100/150/150); Sewer reading auto-copies Water (`linkedReadings` in `properties.js`).
- Uber Nutrition recharge CSV: code 223339 = Units 6+7 only, 223350 = Unit 9 only.
- Flat-site slip PDF: long labels wrap, Reading Period no longer clipped.

## Open items
- Loper Road - Sandvic and other flat_site CSV rows show 0 until that month's slip is entered in the app (not a bug).
- Oct 2025 Agrana Unit 2C solar production reads ~31 kWh in source data (possible meter fault) - unverified.
- CSV BEV tenant-code 269 has TenantCode2 = 193 (client template quirk, left as-is).
- City Deep September 2026 billing period work was still marked in progress.
