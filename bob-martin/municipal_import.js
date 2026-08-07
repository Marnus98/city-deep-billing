// bob-martin/municipal_import.js - imports Bob Martin's actual Ekurhuleni municipal account
// statements (as opposed to import_history.js, which is what HolmStone bills the client - see
// db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables, same split as field-street/municipal_import.js). Source: 5 real "COPY TAX INVOICE"
// statements the client uploaded (Dec 2025, Jan/Feb/Mar/May 2026 - April 2026 and every month
// outside this window simply have no statement yet, same gap pattern as 8 Field Street's).
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
  { label: '2026-01', startDate: '2026-01-01', endDate: '2026-02-01',
    rates: { property_rates: 20500.72, fixed_charge: 3069.24, network_access: 116.1427443258, network_demand: 158.1300062562,
      peak_low: 3.5610002360, standard_low: 2.3425999923, offpeak_low: 1.7875998850,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 487.515, comment: 'Demand=487.515' }, network_demand: { reading: 487.515, comment: 'Demand=487.515' },
      peak_low: 17966.160, standard_low: 46865.039, offpeak_low: 31333.919,
      water: { reading: 35, comment: 'NET of a true 22kL+138kL reading less a 14kL+111kL INTERIM REVERSAL credit correcting Dec 2025\'s over-estimated INTERIM reading - see file header notes' },
      sewer: { reading: 35, comment: 'NET of a true 22kL+138kL reading less a 14kL+111kL INTERIM REVERSAL credit correcting Dec 2025\'s over-estimated INTERIM reading - see file header notes' } } },
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
  // April 2026: no statement uploaded - gap in the municipal history, same as field-street's Apr 2026.
  { label: '2026-05', startDate: '2026-05-01', endDate: '2026-06-01',
    rates: { property_rates: 20500.67, fixed_charge: 3069.24, network_access: 113.3798496180, network_demand: 158.1299972967,
      peak_low: 3.5609998931, standard_low: 2.3425999338, offpeak_low: 1.7875999936,
      refuse_business: 584.46, refuse_litter: 1159.56, water: 49.11, sewer: 18.91 },
    readings: { network_access: { reading: 499.395, comment: 'Demand=499.395' }, network_demand: { reading: 499.395, comment: 'Demand=499.395' },
      peak_low: 20961.840, standard_low: 49038.480, offpeak_low: 33419.999,
      water: 107, sewer: 107 } },
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
      label: m.label, startDate: m.startDate, endDate: m.endDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`Bob Martin municipal account import: ${created} statement(s) added (Dec 2025 - May 2026, Apr 2026 missing).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
