// cranbrook-flavours/municipal_import.js - imports Cranbrook Flavours' actual Ekurhuleni municipal
// account statements (as opposed to import_history.js, which is what HolmStone bills the client -
// see db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables, same split as field-street/bob-martin/loper-road's municipal imports). Source: 4 real
// "COPY TAX INVOICE" statements the client uploaded, covering Nov 2025 and Mar/May/Jun 2026
// consumption - Dec 2025/Jan 2026/Feb 2026 and everything after Jun 2026 are genuinely missing (no
// statement was provided), same "gap, not fabricated" convention as every other property here.
//
// ACCOUNT CHANGEOVER (between Nov 2025 and Mar 2026): the Nov 2025 statement is billed to Ekurhuleni
// account 2604545797 ("JUST NAMES TRADERS 9 CC"); every later statement in this batch (Mar/May/Jun
// 2026) is billed to a different account, 2618624004 ("REFINERY HOLDINGS TWO PTY LTD") - a change of
// registered account holder/number for the same site (467 Martin Road, Tunney Ext 9), same pattern
// already seen on Loper Road's own account changeover. No closeout statement for the old account was
// provided in this batch, so there's nothing to explicitly exclude here - the gap between Nov 2025
// and Mar 2026 (Dec/Jan/Feb) simply has no statement on file for either account.
//
// MARCH 2026's STATEMENT IS A STRETCHED MULTI-MONTH BILL - flagged here for the management-meeting
// accuracy the client asked for: this is the new account's (2618624004) first statement, and its
// water meter reading period runs a full ~70 days, 2026-03-06 to 2026-05-15 (not a clean calendar
// month) - recorded below with those *exact* start/end dates (not rounded to month boundaries) so
// the real billing period is visible on the Municipal Account page and Recovery comparison, not
// just implied by the '2026-03' label. It also carries NO electricity charges at all (the statement
// prints an empty "ELECTRICITY SERVICE" section) - genuinely absent on this statement, not omitted;
// presumably the new account's electricity metering wasn't active/registered for billing yet this
// cycle (May 2026's statement is the first to show electricity charges again, for a clean
// 2026-05-01 to 2026-06-01 period). May 2026's own water meter read window (2026-05-15 to
// 2026-06-12) picks up exactly where March's combined period left off (both read on the 15th) -
// confirms no missing/double-counted water days between the two statements despite March's odd span.
//
// INTERIM REVERSAL netting (March 2026 water/sewer): both physical water meters (23092733,
// 949184903) show a true current-period reading alongside an "INTERIM REVERSAL" crediting back a
// prior over-estimate - same netting convention used throughout this app (true reading minus
// reversal, not the gross printed figure). Meter 23092733: 554kL true less 232kL reversed = 322kL
// net. Meter 949184903: 15kL true less 1kL reversed = 14kL net. Combined (2-meter-combining
// convention, same as Bob Martin/Loper Road): 336kL net water, 336kL net sewer (sewer always tracks
// water 1:1 on this account) - both confirmed against the established flat R49.11/kL water and
// R18.91/kL sewer rates once netted, so the reversal netting itself is correct, not a guess.
//
// TWO ONE-OFF, NON-UTILITY CHARGES included as "sundry"/"deposit" line items (see
// flat_site_tariff_shapes.js's EKURHULENI_MUNICIPAL_E_TOU_CRANBROOK header comment for why, rather
// than excluded the way Loper Road's one-off "Interest on Arrears" was): Nov 2025 carries a small
// "APPL CLEARANCE FIGURES - ELECTRONIC APPL" fee (R110.92 excl VAT), and Mar 2026 carries a new-
// account opening "DEPOSIT-JOURNAL" (R61,836.46, VAT-exempt). Jun 2026 carries a third, a "FINAL
// NOTICE" fee (R211.74 excl VAT). All three sit *inside* their statement's own printed "TOTAL
// CURRENT LEVY", so every month here reconciles exactly to the cent against that figure with them
// included - excluding any of them would leave that month short by exactly that charge's own amount.
//
// A REAL TARIFF-YEAR CHANGE lands on the Jun 2026 statement, identical in kind and almost identical
// in figures to the one already flagged on 8 Field Street's own June 2026 municipal statement (same
// municipality, same Ekurhuleni E TOU tariff class, same July financial-year-start timing): Fixed
// Charge R5,207.09 -> R6,195.35, Water R49.11 -> ~R49.65/kL, Sewer R18.91 -> ~R19.23/kL. June is also
// the one High Demand (winter TOU) month in this batch - Peak/Standard/Off-Peak energy jump
// accordingly (see the shape's _high columns) - expected, not an anomaly; the low-season keys are
// simply unbilled this month (0 rate, no reading, same "unused row" convention used everywhere else
// in this app for a line genuinely not billed in a given period).
//
// Property Rates and Refuse Removal only appear on the Nov 2025 statement (the old account) - absent
// from every Mar/May/Jun 2026 statement (the new account), same as Loper Road's own new account
// showing near-zero Refuse - not imported for those months, left at their "unused row" default of 0.
//
// EXTRACTION METHOD: every reading/cost figure below was read directly off each statement's
// itemised "ELECTRICITY SERVICE"/"WATER SERVICE"/"SEWERAGE"/"REFUSE REMOVAL" lines (exact, not
// estimated); every "rate" is computed as cost/reading. Each month's full set of current-period
// lines reconciles EXACTLY (to the cent) against that statement's own "TOTAL CURRENT LEVY" total -
// the "SUB TOTAL"/"BALANCE BROUGHT FORWARD"/"PAYMENT - THANK YOU" lines above the itemised charges
// are deliberately excluded throughout (account-level carry-forward noise, not a utility charge for
// this period), same convention as every other property's municipal import.
//
// Each month gets its own tariff version (effective_from = that month's start date), same as 8 Field
// Street/AutoZone/Bob Martin, since the Network Access "rate" and several others genuinely differ
// every month here - no stable multi-month rate to de-dup against.
//
// Safe to re-run on every boot: each statement is looked up by its unique label ('2025-11' etc) and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_E_TOU_CRANBROOK } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_Cranbrook Flavours';

const MONTHS = [
  { label: '2025-11', startDate: '2025-11-01', endDate: '2025-12-01', waterStartDate: '2025-11-07', waterEndDate: '2025-12-11',
    rates: { property_rates: 56974.18, fixed_charge: 5207.09, network_access: 10163.45 / 83.432, network_demand: 12188.58 / 83.432,
      peak_low: 3083.74 / 902.999, standard_low: 8500.30 / 3809.400, offpeak_low: 3659.06 / 2161.799,
      refuse: 584.46, sundry: 110.92, water: 12031.95 / 245, sewer: 4632.95 / 245 },
    readings: { network_access: { reading: 83.432, comment: 'Demand=83.432' }, network_demand: { reading: 83.432, comment: 'Demand=83.432' },
      peak_low: 902.999, standard_low: 3809.400, offpeak_low: 2161.799,
      refuse: 1, sundry: { reading: 1, comment: 'APPL CLEARANCE FIGURES - ELECTRONIC APPL fee (one-off, non-utility) - see file header note' },
      water: 245, sewer: 245 } },
  // Stretched ~70-day combined statement (new account 2618624004's first) - see file header note.
  // No electricity billed this cycle. Water/sewer are the NET of an INTERIM REVERSAL correcting a
  // prior over-estimate - see file header note for the meter-by-meter netting.
  { label: '2026-03', startDate: '2026-03-06', endDate: '2026-05-15', waterStartDate: '2026-03-06', waterEndDate: '2026-05-15',
    rates: { deposit: 61836.46, water: 16500.96 / 336, sewer: 6353.76 / 336 },
    readings: {
      deposit: { reading: 1, comment: 'DEPOSIT-JOURNAL - new account 2618624004 opening deposit (one-off, VAT-exempt, non-utility) - see file header note' },
      water: { reading: 336, comment: 'NET of a combined 569kL true reading (554kL+15kL across 2 meters) less a combined 233kL INTERIM REVERSAL credit (232kL+1kL) correcting a prior over-estimate, over the statement\'s own stretched 2026-03-06 to 2026-05-15 reading period - see file header note' },
      sewer: { reading: 336, comment: 'NET of a combined 569kL true reading less a combined 233kL INTERIM REVERSAL credit, same as the water reading above - see file header note' } } },
  // Clean 1-month electricity cycle (2026-05-01 to 2026-06-01); water/sewer meter read window is
  // slightly offset (2026-05-15 to 2026-06-12) but picks up exactly where March's combined period
  // left off - see file header note.
  { label: '2026-05', startDate: '2026-05-01', endDate: '2026-06-01', waterStartDate: '2026-05-15', waterEndDate: '2026-06-12',
    rates: { fixed_charge: 5207.09, network_access: 10163.45 / 60.299, network_demand: 8809.08 / 60.299,
      peak_low: 2999.73 / 878.399, standard_low: 6720.98 / 3012.000, offpeak_low: 3741.32 / 2210.399,
      water: 10509.54 / 214, sewer: 4046.74 / 214 },
    readings: { network_access: { reading: 60.299, comment: 'Demand=60.299' }, network_demand: { reading: 60.299, comment: 'Demand=60.299' },
      peak_low: 878.399, standard_low: 3012.000, offpeak_low: 2210.399,
      water: { reading: 214, comment: 'Meter read window 2026-05-15 to 2026-06-12 (statement\'s own electricity period is 2026-05-01 to 2026-06-01) - see file header note' },
      sewer: { reading: 214, comment: 'Meter read window 2026-05-15 to 2026-06-12 - see file header note' } } },
  // First High Demand (winter) season month in this batch, plus the start of a new municipal
  // financial year (Fixed Charge / water / sewer all step up) - see file header note. Low-season
  // energy keys simply aren't billed this month (0 rate, no reading, standard "unused row"
  // convention). Water/sewer are both INTERIM (estimated, not an actual meter read) this cycle.
  { label: '2026-06', startDate: '2026-06-01', endDate: '2026-07-01',
    rates: { fixed_charge: 6195.35, network_access: 10163.45 / 64.589, network_demand: 9435.81 / 64.589,
      peak_high: 8390.06 / 799.800, standard_high: 9927.19 / 3265.200, offpeak_high: 3720.31 / 1999.200,
      sundry: 211.74, water: 11866.36 / 239, sewer: 4595.03 / 239 },
    readings: { network_access: { reading: 64.589, comment: 'Demand=64.589' }, network_demand: { reading: 64.589, comment: 'Demand=64.589' },
      peak_high: 799.800, standard_high: 3265.200, offpeak_high: 1999.200,
      sundry: { reading: 1, comment: 'FINAL NOTICE fee (one-off, non-utility) - see file header note' },
      water: { reading: 239, comment: 'INTERIM estimate across both water meters (4kL + 235kL), not an actual meter read this cycle' },
      sewer: { reading: 239, comment: 'INTERIM estimate across both water meters (4kL + 235kL), not an actual meter read this cycle' } } },
];

function main(dbFile = 'cranbrook-flavours.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: EKURHULENI_MUNICIPAL_E_TOU_CRANBROOK, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate,
      waterStartDate: m.waterStartDate, waterEndDate: m.waterEndDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`Cranbrook Flavours municipal account import: ${created} statement(s) added (Nov 2025, Mar/May/Jun 2026 - Dec 2025/Jan/Feb 2026 missing, no statement provided).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
