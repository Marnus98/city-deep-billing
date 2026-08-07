// loper-road/municipal_import.js - imports Loper Road - Sandvic's actual Ekurhuleni municipal
// account statements (as opposed to import_history.js, which is what HolmStone bills the client -
// see db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables, same split as field-street/bob-martin/autozone's municipal imports). Source: 6 real "COPY
// TAX INVOICE" statements the client uploaded, covering Dec 2025 and Jan/Feb/Mar/Apr/Jun 2026
// consumption (invoiced ~1 month later than the consumption period itself, e.g. the Dec 2025
// consumption statement is invoiced/dated 2026-01-28 - labelled here by consumption period start,
// same convention as every other property's municipal import).
//
// ACCOUNT CHANGEOVER (2026-04/05): Ekurhuleni account 1711418291 (the account behind every month
// through Mar 2026) was closed out and its deposit transferred to a brand new account, 1712424685,
// sometime around late April/May 2026 - confirmed by the old account's own final statement (0 kWh
// consumption, a pure water/sewer "INTERIM REVERSAL" credit, and an explicit "TRANSFER DEPOSIT-
// 1712424685" / "REVERSE DEPOSIT- 1712424685" ledger pair, netting to a -R8,526.31 refund-shaped
// "TOTAL CURRENT LEVY" - not a real utility charge for any period, so NOT imported as its own
// statement here). The new account's own first statement (invoiced 2026-06-30) has a stretched
// ~61-day reading period (2026-04-01 to 2026-06-01) covering BOTH April's and May's consumption in
// one combined bill - imported below as '2026-04' (matching the reading period's own start month,
// same convention as everywhere else in this app), with no separate '2026-05' entry - May's usage
// genuinely has no standalone figure to report, it's baked into this one combined statement. The new
// account's SECOND statement (invoiced 2026-07-28) is back to a clean one-month cycle and covers
// June 2026 normally, imported as '2026-06'.
//
// The new account's statements also show a near-zero "Refuse: Litterpicking" charge (R0.16-R0.17,
// down from R278.72) - not a service change, just the new account's own municipal record still
// carrying a placeholder Area of 1m2 (vs the old account's correct 1,672m2) that Ekurhuleni hasn't
// re-populated yet; and no separate "Environmental Levy" refuse line at all this account (refuse_levy
// recorded as 0 for both new-account months) - genuinely absent from these 2 statements, not omitted.
//
// EXTRACTION METHOD: every reading/cost figure below was read directly off each statement's
// itemised "ELECTRICITY SERVICE"/"WATER SERVICE"/"SEWERAGE"/"REFUSE REMOVAL" lines (exact, not
// estimated); every "rate" is computed as cost/reading. Each month's full set of current-period
// lines reconciles EXACTLY (to the cent) against that statement's own "TOTAL CURRENT LEVY" total -
// the "SUB TOTAL" balance-brought-forward/payment-received lines above the itemised charges are
// deliberately excluded, same convention as every other property's municipal import (they're
// account-level carry-forward noise, not a utility charge for this period).
//
// No Property Rates line exists on this statement at all (unlike 8 Field Street/Bob Martin/
// AutoZone) - genuinely absent, not omitted by mistake - see the shape's own comment in
// flat_site_tariff_shapes.js.
//
// Electricity is billed completely differently here from how HolmStone bills the client for this
// same site: no Peak/Standard/Off-Peak TOU split at all on the municipal statement, just one flat
// "Energy Charge" meter (S021409628) plus a separate Demand meter (D021409628) - see the new
// EKURHULENI_MUNICIPAL_INDUSTRIAL_C_LOPER_ROAD shape's own header comment for why this needed a
// brand new shape rather than reusing the client-billing EKURHULENI_INDUSTRIAL_C one.
//
// "Network Access Charge" is a flat R3,507.92 in all 4 months regardless of the Demand meter's kVA
// moving around - same "barely tracks its own reading" quirk already flagged for Bob Martin's
// identical line item. Reading reuses the Demand meter's own kVA purely for display consistency.
//
// Water/Sewer: two physical meters (100064836, 10351198) combined into one reading/cost per month,
// same two-meter-combining convention as Bob Martin. Both rates are a clean flat R49.11/kL (water)
// and R18.91/kL (sewer) across all 4 months - no sliding scale, no mid-cycle change - the exact same
// two rates already seen on Bob Martin's own statements (same municipality/tariff book). Each
// statement double-prints a second, R0.00 Sewer line alongside the real one - not imported, since it
// never carries a reading or cost (see the shape's own comment for more).
//
// Safe to re-run on every boot: each statement is looked up by its unique label ('2025-12' etc) and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_INDUSTRIAL_C_LOPER_ROAD } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_Loper Road - Sandvic';

const MONTHS = [
  { label: '2025-12', startDate: '2025-12-01', endDate: '2026-01-01',
    rates: { fixed_charge: 3389.73, energy_charge: 6403.60 / 2828.32, demand_charge: 6490.93 / 26.801,
      network_access: 3507.92 / 26.801, refuse_litter: 278.72, refuse_levy: 584.46, water: 49.11, sewer: 18.91 },
    readings: { energy_charge: 2828.32,
      demand_charge: { reading: 26.801, comment: 'Demand=26.801' }, network_access: { reading: 26.801, comment: 'Demand=26.801' },
      water: 62, sewer: 62 } },
  { label: '2026-01', startDate: '2026-01-01', endDate: '2026-02-01',
    rates: { fixed_charge: 3389.73, energy_charge: 7600.31 / 3356.88, demand_charge: 5909.68 / 24.401,
      network_access: 3507.92 / 24.401, refuse_litter: 278.72, refuse_levy: 584.46, water: 49.11, sewer: 18.91 },
    readings: { energy_charge: 3356.88,
      demand_charge: { reading: 24.401, comment: 'Demand=24.401' }, network_access: { reading: 24.401, comment: 'Demand=24.401' },
      water: 62, sewer: 62 } },
  { label: '2026-02', startDate: '2026-02-01', endDate: '2026-03-01',
    rates: { fixed_charge: 3389.73, energy_charge: 10697.69 / 4724.919, demand_charge: 6180.93 / 25.521,
      network_access: 3507.92 / 25.521, refuse_litter: 278.72, refuse_levy: 584.46, water: 49.11, sewer: 18.91 },
    readings: { energy_charge: 4724.919,
      demand_charge: { reading: 25.521, comment: 'Demand=25.521' }, network_access: { reading: 25.521, comment: 'Demand=25.521' },
      water: { reading: 54, comment: 'INTERIM estimate, not an actual meter read this cycle' },
      sewer: { reading: 54, comment: 'INTERIM estimate, not an actual meter read this cycle' } } },
  { label: '2026-03', startDate: '2026-03-01', endDate: '2026-04-01',
    rates: { fixed_charge: 3389.73, energy_charge: 10699.68 / 4725.8, demand_charge: 6045.06 / 24.960,
      network_access: 3507.92 / 24.960, refuse_litter: 278.72, refuse_levy: 584.46, water: 49.11, sewer: 18.91 },
    readings: { energy_charge: 4725.8,
      demand_charge: { reading: 24.960, comment: 'Demand=24.960' }, network_access: { reading: 24.960, comment: 'Demand=24.960' },
      // Both physical water meters read an INTERIM estimate this cycle (100064836: 1kL, 10351198: 54kL) -
      // combined into one 55kL reading/R2,701.05 cost, same two-meter-combining convention as every
      // other month (see file header note).
      water: { reading: 55, comment: 'INTERIM estimate (1kL + 54kL across the 2 water meters), not an actual meter read this cycle' },
      sewer: { reading: 55, comment: 'INTERIM estimate (1kL + 54kL across the 2 water meters), not an actual meter read this cycle' } } },
  // New account 1712424685's first statement - stretched ~61-day reading period (2026-04-01 to
  // 2026-06-01) combining April's and May's consumption into one bill - see file header note on the
  // account changeover. A one-off R1.46 "Interest on Arrears" ledger charge on this statement is
  // excluded here (not a utility charge, same convention as every other property's one-off penalty/
  // interest exclusions), so this month's own total sits R1.46 below the statement's own printed
  // "TOTAL CURRENT LEVY" of R31,494.77 - expected, not a reconciliation error.
  { label: '2026-04', startDate: '2026-04-01', endDate: '2026-06-01',
    rates: { fixed_charge: 3389.73, energy_charge: 11131.49 / 4916.520, demand_charge: 6839.45 / 28.240,
      network_access: 3507.92 / 28.240, refuse_litter: 0.16, refuse_levy: 0, water: 49.11, sewer: 18.91 },
    readings: { energy_charge: 4916.520,
      demand_charge: { reading: 28.240, comment: 'Demand=28.240' }, network_access: { reading: 28.240, comment: 'Demand=28.240' },
      water: { reading: 37, comment: 'Covers a combined ~61-day Apr-May reading period (new account 1712424685) - see file header note' },
      sewer: { reading: 37, comment: 'Covers a combined ~61-day Apr-May reading period (new account 1712424685) - see file header note' } } },
  { label: '2026-06', startDate: '2026-06-01', endDate: '2026-07-01',
    rates: { fixed_charge: 4338.39, energy_charge: 20876.02 / 4524.200, demand_charge: 6510.07 / 26.880,
      network_access: 3507.92 / 26.880, refuse_litter: 0.17, refuse_levy: 0, water: 1837.05 / 37, sewer: 18.91 },
    readings: { energy_charge: 4524.200,
      demand_charge: { reading: 26.880, comment: 'Demand=26.880' }, network_access: { reading: 26.880, comment: 'Demand=26.880' },
      water: 37, sewer: 37 } },
];

function main(dbFile = 'loper-road.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: EKURHULENI_MUNICIPAL_INDUSTRIAL_C_LOPER_ROAD, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`Loper Road - Sandvic municipal account import: ${created} statement(s) added (Dec 2025, Jan-Apr 2026, Jun 2026 - May 2026's usage is folded into Apr's combined statement, see file header note).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
