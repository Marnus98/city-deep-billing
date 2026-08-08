// bob-martin/municipal_import.js - imports Bob Martin's actual Ekurhuleni municipal account
// statements (as opposed to import_history.js, which is what HolmStone bills the client - see
// db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables, same split as field-street/municipal_import.js). Source: 7 real "COPY TAX INVOICE"
// statements the client uploaded, Dec 2025 - Jun 2026 with no gaps (April 2026, previously missing,
// and June 2026 were both added 2026-08-07 alongside a fresh Dec/Jan/Feb/Mar/May re-upload that
// matched what was already on file to the cent).
//
// April 2026's water/sewer section is a multi-month catch-up read (meter reading dates span
// 2026-02-09 to 2026-05-05, 85 days, covering the INTERIM-estimated Feb/Mar readings already
// booked) with a large "INTERIM REVERSAL" credit line crediting back the earlier over-estimate -
// handled the same way as Jan 2026's own INTERIM REVERSAL (see below): NET of the true reading minus
// the reversal credit (99kL net across both meters, not the gross 309kL actually printed), which
// reconciles cleanly to the same established R49.11/kL water + R18.91/kL sewer rates. Jan 2026's own
// catch-up read window is 2025-12-05 to 2026-02-09 (66 days) - both windows are recorded in each
// reading's own comment (not just here) so they're visible on the Municipal Account page itself, and
// both are long enough to trip the app's own >35-day "long period" flag (see municipal_compare.js's
// LONG_PERIOD_DAYS) even though the *statement's* own billing cycle (start_date/end_date) is a clean
// single month each time - only the water/sewer sub-reading is stretched, not the whole statement.
//
// June 2026 is the first High Demand (winter) season month in this whole history - confirmed by the
// tariff code itself changing on the statement (from "ELD1-" to "ELD1.2-") and all 3 energy rates
// jumping well above their low-season values (peak R3.561 -> R10.868, standard R2.343 -> R3.177,
// off-peak R1.788 -> R1.964/kWh) - modelled using the shape's _high columns instead of _low for this
// one month. Fixed Charge also roughly doubled (R3,069.24 -> R6,154.68) and Property
// Rates/Refuse/water all ticked up slightly too (a routine annual rate adjustment, not an anomaly) -
// water's own rate moved from R49.11 to ~R49.90/kL this month (sewer's R18.91/kL didn't change).
//
// EXTRACTION METHOD - every reading/cost figure below was read directly off each statement (exact,
// not estimated); every "rate" is computed as cost/reading (same convention as field-street's
// municipal import). One thing about this site's statement layout that differs from 8 Field
// Street's: Refuse Removal is billed as two separate flat lines every month - "Business" bin
// collection (R584.46) and area-wide "Litter-picking" (R1,159.56) - kept as two line items rather
// than combined into one, since the source statement itself never merges them.
//
// "Network Access Charge" shares its Reading with Network Demand - both are read off the same kVA
// meter (the statement's own "Demand = X" line covers both charges). Its cost barely tracks that
// reading (mid-R56,000s regardless of kVA moving around, ~R56,621.33 every month bar a few cents),
// so the "rate" shown for this row is only cost/reading for display consistency, same caveat
// field-street's municipal import already flags for this exact line - not necessarily how
// Ekurhuleni's own tariff book computes it.
//
// Peak/Standard/Off-Peak are not printed as labels matching our own terminology - the statement's
// own meter labels ("PEAK" on meter P, "STD" on meter S, "OFF-P" on meter O) were cross-checked by
// computing implied rate = cost/reading for each month; Jan/Feb/Mar/May 2026 all bill exactly as
// labelled (P=peak rate ~R3.561, S=standard rate ~R2.343, O=offpeak rate ~R1.788), matching Bob
// Martin's own site-billing D1 TOU rates exactly - EXCEPT Dec 2025, where meters P and S are
// genuinely swapped on the statement itself (meter "S" bills at the peak rate, meter "P" bills at
// the standard rate) - flagged here rather than silently trusting the printed label; classification
// below is by implied rate (our system's own peak/standard/offpeak definition), not the meter's own
// P/S/O text, so Dec's figures land in the correct bucket regardless of the municipality's mix-up.
// No High Demand (winter) month falls in this 5-month window, so every month uses the _low columns.
//
// Water/Sewer: two separate physical meters (110126972 and 110155752) combined into one reading per
// month (matching how the client's own site billing already treats water as one combined figure -
// cross-checked: May 2026's combined 107kL/R5,254.77 exactly matches the water/sewer this app
// already bills the client for that same month). Jan 2026 carries an "INTERIM REVERSAL" crediting
// back Dec 2025's over-estimated INTERIM reading once the actual meter was read - same anomaly
// pattern as field-street's Oct 2025 - recorded here as the NET incremental reading (35kL, not the
// gross 160kL/22kL+138kL actually printed), to avoid a misleading spike in the trend chart. Feb and
// Mar 2026 are both flagged "INTERIM" on the statement (not an actual read that cycle).
//
// Every month's full set of figures reconciles to within a few cents of that statement's own
// current-period total (its "TOTAL CURRENT LEVY" sub-total, not "Total Charge (excl. VAT)" - the
// latter includes any brought-forward balance still outstanding, e.g. May 2026 carries Apr's whole
// R384,560.48 balance forward since nothing had been paid against it yet). Dec 2025 also carries a
// one-off R211.74 "FINAL NOTICE" late-payment penalty, deliberately excluded here as it isn't a
// utility charge.
//
// Rates barely move across this 5-month window (network_demand/peak/standard/offpeak/water/sewer
// are the same to 4 decimal places every month) - still given one tariff version per month (like
// field-street) rather than grouped into an era, for the same reason: nothing to lose by keeping
// each month's own precise implied rate, and it costs nothing since each label is already unique.
//
// WATER'S OWN READING PERIOD (added 2026-08-08, for the client's over/under-recovery meeting): water
// is read on its own cycle here too, genuinely different from electricity's calendar-month cycle -
// e.g. May 2026's water is read 2026-05-05 to 2026-06-02, while that statement's electricity is
// 2026-05-01 to 2026-06-01. Every month with a real (non-INTERIM) water reading now carries its own
// waterStartDate/waterEndDate so the Recovery page/PDF can show both periods side by side. Left unset
// for Dec 2025/Feb 2026/Mar 2026, where water was INTERIM (estimated) and the statement itself prints
// no water reading date.
//
// Safe to re-run on every boot: each statement is looked up by its unique label ('2025-12' etc) and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { EKURHULENI_MUNICIPAL_D1_TOU_BOB_MARTIN } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'Ekurhuleni_Municipal_Account_Bob Martin';

const MONTHS = [
  { label: '2025-12', startDate: '2025-12-01', endDate: '2026-01-01',
    rates: { property_rates: 20500.72, fixed_charge: 3069.24, network_access: 117.2308536409, network_demand: 158.1300026916,
      peak_low: 3.5610002549, standard_low: 2.3425999488, offpeak_low: 1.7875999204,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 482.990, comment: 'Demand=482.990' }, network_demand: { reading: 482.990, comment: 'Demand=482.990' },
      peak_low: 6591.120, standard_low: 17688.479, offpeak_low: 14871.840,
      water: 125, sewer: 125 } },
  { label: '2026-01', startDate: '2026-01-01', endDate: '2026-02-01', waterStartDate: '2025-12-05', waterEndDate: '2026-02-09',
    rates: { property_rates: 20500.72, fixed_charge: 3069.24, network_access: 116.1427443258, network_demand: 158.1300062562,
      peak_low: 3.5610002360, standard_low: 2.3425999923, offpeak_low: 1.7875998850,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 487.515, comment: 'Demand=487.515' }, network_demand: { reading: 487.515, comment: 'Demand=487.515' },
      peak_low: 17966.160, standard_low: 46865.039, offpeak_low: 31333.919,
      water: { reading: 35, comment: 'NET of a true 22kL+138kL reading (meter read window 2025-12-05 to 2026-02-09, 66 days) less a 14kL+111kL INTERIM REVERSAL credit correcting Dec 2025\'s over-estimated INTERIM reading - see file header notes' },
      sewer: { reading: 35, comment: 'NET of a true 22kL+138kL reading (meter read window 2025-12-05 to 2026-02-09, 66 days) less a 14kL+111kL INTERIM REVERSAL credit correcting Dec 2025\'s over-estimated INTERIM reading - see file header notes' } } },
  { label: '2026-02', startDate: '2026-02-01', endDate: '2026-03-01',
    rates: { property_rates: 20500.72, fixed_charge: 3069.24, network_access: 119.0323957282, network_demand: 158.1300033636,
      peak_low: 3.5609997756, standard_low: 2.3426000812, offpeak_low: 1.7875999493,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 475.680, comment: 'Demand=475.680' }, network_demand: { reading: 475.680, comment: 'Demand=475.680' },
      peak_low: 20141.279, standard_low: 51040.560, offpeak_low: 31566.000,
      water: { reading: 105, comment: 'INTERIM estimate, not an actual meter read this cycle' },
      sewer: { reading: 105, comment: 'INTERIM estimate, not an actual meter read this cycle' } } },
  { label: '2026-03', startDate: '2026-03-01', endDate: '2026-04-01',
    rates: { property_rates: 20500.72, fixed_charge: 3069.24, network_access: 119.5281682559, network_demand: 158.1300044120,
      peak_low: 3.5609999273, standard_low: 2.3425999654, offpeak_low: 1.7876000753,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 473.707, comment: 'Demand=473.707' }, network_demand: { reading: 473.707, comment: 'Demand=473.707' },
      peak_low: 26956.319, standard_low: 60130.800, offpeak_low: 39897.839,
      water: { reading: 105, comment: 'INTERIM estimate, not an actual meter read this cycle' },
      sewer: { reading: 105, comment: 'INTERIM estimate, not an actual meter read this cycle' } } },
  { label: '2026-04', startDate: '2026-04-01', endDate: '2026-05-01', waterStartDate: '2026-02-09', waterEndDate: '2026-05-05',
    rates: { property_rates: 20500.72, fixed_charge: 3069.24, network_access: 113.79845163779902, network_demand: 158.13000695396317,
      peak_low: 3.561000186249003, standard_low: 2.3426000256245123, offpeak_low: 1.7876001233835248,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 497.558, comment: 'Demand=497.558' }, network_demand: { reading: 497.558, comment: 'Demand=497.558' },
      peak_low: 13745.040, standard_low: 33350.879, offpeak_low: 23860.560,
      water: { reading: 99, comment: 'NET of a true 50kL+259kL (=309kL) reading (meter read window 2026-02-09 to 2026-05-05, 85 days) less a 26kL+184kL (=210kL) INTERIM REVERSAL credit correcting Feb/Mar 2026\'s over-estimated INTERIM readings - see file header notes' },
      sewer: { reading: 99, comment: 'NET of a true 50kL+259kL (=309kL) reading (meter read window 2026-02-09 to 2026-05-05, 85 days) less a 26kL+184kL (=210kL) INTERIM REVERSAL credit correcting Feb/Mar 2026\'s over-estimated INTERIM readings - see file header notes' } } },
  { label: '2026-05', startDate: '2026-05-01', endDate: '2026-06-01', waterStartDate: '2026-05-05', waterEndDate: '2026-06-02',
    rates: { property_rates: 20500.67, fixed_charge: 3069.24, network_access: 113.3798496180, network_demand: 158.1299972967,
      peak_low: 3.5609998931, standard_low: 2.3425999338, offpeak_low: 1.7875999936,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 499.395, comment: 'Demand=499.395' }, network_demand: { reading: 499.395, comment: 'Demand=499.395' },
      peak_low: 20961.840, standard_low: 49038.480, offpeak_low: 33419.999,
      water: 107, sewer: 107 } },
  // June 2026: first High Demand (winter) season month - uses the shape's _high columns instead of
  // _low (see file header notes); low-season keys simply aren't billed this month (no reading, rate
  // defaults to 0, same "unused row" convention used throughout this app for a line item that
  // genuinely isn't billed in a given period).
  { label: '2026-06', startDate: '2026-06-01', endDate: '2026-07-01', waterStartDate: '2026-06-02', waterEndDate: '2026-07-06',
    rates: { property_rates: 20806.70, fixed_charge: 6154.68, network_access: 114.08230577047067, network_demand: 158.12999677627337,
      peak_high: 10.867900172828001, standard_high: 3.177400049399529, offpeak_high: 1.9636000812810848,
      refuse_business: 604.33, refuse_litter: 1199.21, water: 49.90368, sewer: 18.91 },
    readings: { network_access: { reading: 496.320, comment: 'Demand=496.320' }, network_demand: { reading: 496.320, comment: 'Demand=496.320' },
      peak_high: 24209.040, standard_high: 59919.600, offpeak_high: 40550.640,
      water: 125, sewer: 125 } },
];

function main(dbFile = 'bob-martin.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: EKURHULENI_MUNICIPAL_D1_TOU_BOB_MARTIN, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate,
      waterStartDate: m.waterStartDate, waterEndDate: m.waterEndDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`Bob Martin municipal account import: ${created} statement(s) added (Dec 2025 - Jun 2026, no gaps).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
