// field-street/municipal_import.js - imports 8 Field Street's actual Ekurhuleni municipal account
// statements (as opposed to seed.js/import_history.js, which are what HolmStone bills the client -
// see db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables). Source: 10 real "COPY TAX INVOICE" statements the client uploaded (Sep 2025 - Jun 2026,
// no gaps - April 2026 was added 2026-08-07, filling what had been the one missing month; Jul 2025/
// Aug 2025/Jul 2026 are outside this batch entirely).
//
// April 2026's water/sewer section carries a large "INTERIM REVERSAL" crediting back March 2026's
// own INTERIM-estimated 178kL reading once the meter was actually read (Curr/Prev reading dates span
// 2026-03-11 to 2026-05-13, a ~2-month gap covering both months) - handled the same NET-of-reversal
// way as every other INTERIM REVERSAL month in this file (October 2025 above): 183kL net (the true
// 361kL reading less March's already-booked 178kL estimate), not the 361kL gross figure printed.
//
// EXTRACTION METHOD - every reading/cost figure below was read directly off each statement (exact,
// not estimated); every "rate" is *computed* as cost/reading, matching the convention set by the
// client's own "Example for Municipality readings.xlsx" reference file (Entry/Rate/Unit/Reading/
// Cost, same shape as our own billing slips) - the source statements themselves mostly don't print
// a per-unit rate for electricity, just the Rand cost, so displaying an implied rate here is for
// consistency with the rest of this app, not necessarily how Ekurhuleni's tariff book itself works
// (see the Network Access note below for why that matters).
//
// Peak/Standard/Off-Peak and High/Low Demand season are not printed as labels next to each kWh
// figure on the statement itself (only the Rand cost and a meter number are) - each was identified
// by (a) computing implied rate = cost/reading for the three kWh lines each month and sorting
// descending (Peak always highest, Standard middle, Off-Peak lowest - true in every month checked),
// and (b) High Demand season = the reading period spans June (Ekurhuleni's TOU winter window,
// matching the same pattern already established for the client's own historical billing in
// import_history.js) - every other month here is Low Demand. Every month's full set of extracted
// figures was cross-checked by summing back to that statement's own printed "Total Charge (excl.
// VAT)" figure - all 9 reconcile to within a few cents (the municipality's own rounding carryover
// between billing cycles), so the classification above is on solid ground, not a guess.
//
// FOUR THINGS FLAGGED BACK TO THE CLIENT (see chat reply) rather than silently smoothed over:
// 1. "Network Access Charge" does NOT scale with the kVA reading the way "Network Demand" does -
//    Network Demand's cost/kVA is a rock-steady ~R146.09 every single month, but Network Access is
//    a near-flat ~R64,752.79/month for 7 of the 9 months (Sep25-Mar26) despite the kVA reading
//    itself moving around - then drops to R61,523.75 (May26) and R60,936.30 (Jun26). The "rate"
//    shown for this row is only cost/reading for display consistency with the rest of the app; the
//    underlying charge looks like a stepped flat fee, not a true per-kVA rate - worth confirming
//    with Ekurhuleni directly if that R64,752.79 -> R61,523.75 -> R60,936.30 step looks right.
// 2. October 2025's statement rolled up TWO months' charges into one "Total Charge (excl. VAT)"
//    figure (R1,832,501.42) because September's balance went unpaid before this invoice printed -
//    that ISN'T this month's utility usage, it's Sep's balance carried forward. This script records
//    October's own actual charges only (R836,917.25, reconciling to the statement's own "TOTAL
//    CURRENT LEVY" sub-total of R959,249.74 incl. VAT), the same way every other month here works.
//    That same October statement also shows a "INTERIM REVERSAL" crediting back R39,779.10 water /
//    R15,317.10 sewer, reversing 810kL that had been over-estimated in prior "INTERIM" months below
//    - net effect, October's *own* water+sewer reading is just 25kL (835kL actual less the 810kL
//    already-billed estimate), not the 835kL printed on the "WATER" line - see the reading comment.
// 3. September 2025 (405kL) and March 2026 (178kL) water/sewer are both marked "INTERIM" on the
//    statement itself - i.e. Ekurhuleni's own estimate, not an actual meter read that cycle - flagged
//    via each reading's comment. Treat those two months' water/sanitation figures as rougher than
//    the others.
// 4. A real tariff-year change lands on the June 2026 statement: Property Rates +1.5% (R21,367.42 ->
//    R21,686.33), Fixed Charge +19% (R5,207.09 -> R6,195.35), Refuse +3.4% (R584.46 -> R604.33), and
//    Water/Sewer rates step up too (R49.11 -> R49.65 water, R18.91 -> R19.23 sewer) - all consistent
//    with an annual municipal tariff reset (same July-ish timing as the rate change already seen on
//    the client's own site billing side), not a data error. June is also the one High Demand month
//    in this batch (SA winter TOU window), so its Peak/Standard/Off-Peak rates jump for that reason
//    too - expected, not an anomaly.
//
// Each month gets its own tariff version (effective_from = that month's start date) rather than
// being grouped into eras, because the Network Access "rate" above genuinely differs every month -
// there's no stable multi-month rate to de-dup against here the way the client's own site billing
// tariff naturally groups into eras.
//
// Safe to re-run on every boot: each statement is looked up by its unique label ('2025-09' etc) and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_E_TOU_8FS } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_8 Field Street';

const MONTHS = [
  { label: '2025-09', startDate: '2025-09-01', endDate: '2025-10-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 103.5181712524, network_demand: 146.0899953799, peak_low: 3.4150000851, standard_low: 2.2314000249, offpeak_low: 1.6926000188, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 625.521, comment: 'Demand=625.521' }, network_demand: { reading: 625.521, comment: 'Demand=625.521' },
      peak_low: 46982.4, standard_low: 109165.2, offpeak_low: 149848.799,
      water: { reading: 405, comment: 'INTERIM estimate, not an actual meter read this cycle' },
      sewer: { reading: 405, comment: 'INTERIM estimate, not an actual meter read this cycle' } } },
  { label: '2025-10', startDate: '2025-10-01', endDate: '2025-11-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 105.4619441296, network_demand: 146.0899979153, peak_low: 3.4150000675, standard_low: 2.2314000184, offpeak_low: 1.6926000222, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 613.992, comment: 'Demand=613.992' }, network_demand: { reading: 613.992, comment: 'Demand=613.992' },
      peak_low: 50579.999, standard_low: 108870.0, offpeak_low: 140578.8,
      water: { reading: 25, comment: 'NET of a true 835kL reading (meter read window 2025-08-11 to 2025-11-12, 93 days) less an 810kL INTERIM REVERSAL credit correcting prior over-estimated months - see file header notes' },
      sewer: { reading: 25, comment: 'NET of a true 835kL reading (meter read window 2025-08-11 to 2025-11-12, 93 days) less an 810kL INTERIM REVERSAL credit correcting prior over-estimated months - see file header notes' } } },
  { label: '2025-11', startDate: '2025-11-01', endDate: '2025-12-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 105.9847977701, network_demand: 146.0899923563, peak_low: 3.4150000831, standard_low: 2.23140002, offpeak_low: 1.6926000338, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 610.963, comment: 'Demand=610.963' }, network_demand: { reading: 610.963, comment: 'Demand=610.963' },
      peak_low: 41081.999, standard_low: 95668.799, offpeak_low: 127966.8, water: 205, sewer: 205 } },
  { label: '2025-12', startDate: '2025-12-01', endDate: '2026-01-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 108.1352442248, network_demand: 146.0899980461, peak_low: 3.4150001266, standard_low: 2.2313999627, offpeak_low: 1.6925999886, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 598.813, comment: 'Demand=598.813' }, network_demand: { reading: 598.813, comment: 'Demand=598.813' },
      peak_low: 31598.4, standard_low: 77500.799, offpeak_low: 110949.599, water: 125, sewer: 125 } },
  { label: '2026-01', startDate: '2026-01-01', endDate: '2026-02-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 104.6843035277, network_demand: 146.0900036052, peak_low: 3.415000096, standard_low: 2.2314000044, offpeak_low: 1.6925999993, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 618.553, comment: 'Demand=618.553' }, network_demand: { reading: 618.553, comment: 'Demand=618.553' },
      peak_low: 41684.4, standard_low: 89745.599, offpeak_low: 115960.8, water: 189, sewer: 189 } },
  { label: '2026-02', startDate: '2026-02-01', endDate: '2026-03-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 109.2286009726, network_demand: 146.0900038629, peak_low: 3.4150000375, standard_low: 2.2314000458, offpeak_low: 1.6925999802, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 592.819, comment: 'Demand=592.819' }, network_demand: { reading: 592.819, comment: 'Demand=592.819' },
      peak_low: 37720.799, standard_low: 80308.8, offpeak_low: 104607.599, water: 215, sewer: 215 } },
  { label: '2026-03', startDate: '2026-03-01', endDate: '2026-04-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 102.6700840986, network_demand: 146.0900001268, peak_low: 3.4150000461, standard_low: 2.2313999762, offpeak_low: 1.6925999843, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 630.688, comment: 'Demand=630.688' }, network_demand: { reading: 630.688, comment: 'Demand=630.688' },
      peak_low: 43357.2, standard_low: 94513.199, offpeak_low: 122659.2,
      water: { reading: 178, comment: 'INTERIM estimate, not an actual meter read this cycle' },
      sewer: { reading: 178, comment: 'INTERIM estimate, not an actual meter read this cycle' } } },
  { label: '2026-04', startDate: '2026-04-01', endDate: '2026-05-01',
    rates: { property_rates: 21367.42, fixed_charge: 5207.09, network_access: 104.3011959892079, network_demand: 146.08999315427053,
      peak_low: 3.4150000000000005, standard_low: 2.231399958634992, offpeak_low: 1.6925999884364658, refuse: 584.46, water: 49.10999999999999, sewer: 18.91 },
    readings: { network_access: { reading: 620.825, comment: 'Demand=620.825' }, network_demand: { reading: 620.825, comment: 'Demand=620.825' },
      peak_low: 42366.000, standard_low: 100775.999, offpeak_low: 138366.000,
      water: { reading: 183, comment: 'NET of a true 361kL reading (meter read window 2026-03-11 to 2026-05-13, 63 days) less a 178kL INTERIM REVERSAL credit correcting March 2026\'s over-estimated INTERIM reading - see file header notes' },
      sewer: { reading: 183, comment: 'NET of a true 361kL reading (meter read window 2026-03-11 to 2026-05-13, 63 days) less a 178kL INTERIM REVERSAL credit correcting March 2026\'s over-estimated INTERIM reading - see file header notes' } } },
  { label: '2026-05', startDate: '2026-05-01', endDate: '2026-06-01',
    rates: { property_rates: 21367.38, fixed_charge: 5207.09, network_access: 99.7044862663, network_demand: 146.0899975853, peak_low: 3.4149999012, standard_low: 2.2314000295, offpeak_low: 1.6926000101, refuse: 584.46, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 617.061, comment: 'Demand=617.061' }, network_demand: { reading: 617.061, comment: 'Demand=617.061' },
      peak_low: 46411.199, standard_low: 105610.799, offpeak_low: 142605.6, water: 222, sewer: 222 } },
  { label: '2026-06', startDate: '2026-06-01', endDate: '2026-07-01',
    rates: { property_rates: 21686.33, fixed_charge: 6195.35, network_access: 101.1165981342, network_demand: 146.0899982411, peak_high: 10.4902000955, standard_high: 3.040299987, offpeak_high: 1.8609000333, refuse: 604.33, water: 49.65, sewer: 19.2260103627 },
    readings: { network_access: { reading: 602.634, comment: 'Demand=602.634' }, network_demand: { reading: 602.634, comment: 'Demand=602.634' },
      peak_high: 41880.0, standard_high: 95230.8, offpeak_high: 116686.8,
      water: { reading: 193, comment: 'INTERIM estimate, not an actual meter read this cycle' },
      sewer: { reading: 193, comment: 'INTERIM estimate, not an actual meter read this cycle' } } },
];

function main(dbFile = 'field-street.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: EKURHULENI_MUNICIPAL_E_TOU_8FS, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`8 Field Street municipal account import: ${created} statement(s) added (Sep 2025 - Jun 2026, no gaps).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
