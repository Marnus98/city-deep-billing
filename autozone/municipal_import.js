// autozone/municipal_import.js - imports AutoZone's actual City of Johannesburg municipal account
// statements (as opposed to import_history.js, which is what HolmStone bills the client - see
// db.js's municipal_tariffs/municipal_statement_slips for why these live in a separate set of
// tables, same split as every other property's municipal import). Source: 6 real "TAX INVOICE"
// statements the client uploaded (Dec 2025, Jan/Mar/Apr/May/Jun 2026 - Feb 2026 and Jul 2026 simply
// have no statement yet).
//
// This is a genuinely different municipal format from every Ekurhuleni-based site in this app: City
// of Johannesburg combines four separately VAT-registered sub-accounts on one statement (City of
// Johannesburg itself for Property Rates + Sundry, City Power for Electricity, Johannesburg Water
// for Water & Sanitation, PIKITUP for Refuse) - see AUTOZONE_COJ_MUNICIPAL in
// flat_site_tariff_shapes.js. Two things that made this easier than Ekurhuleni's statements: Off-
// Peak/Peak/Standard are printed with their own labels and rates directly (no implied-rate
// classification needed), and each statement's own "Statement for <Month>" cover page is one cycle
// AHEAD of the actual usage - e.g. the invoice dated 2026/01/05 is "Statement For January 2026" but
// its own reading periods (electricity Reading period = 2025/11/26 to 2025/12/25, water similar) are
// what HolmStone actually bills as December 2025 usage - so every label below matches the source
// PDF's filename/reading period, not its own cover-page "Statement For" month.
//
// EXTRACTION METHOD - every reading/cost figure below was read directly off each statement (exact,
// not estimated). Two implied rates ARE computed (cost/reading) purely for display consistency with
// the rest of the app, same caveat already flagged for other sites' Network Access-style rows:
// - "Network Surcharge kWh" is only ever printed as a Rand total, no rate/reading of its own - but it
//   reconciles exactly to 0.06 x (that month's total metered kWh) every month checked, so that's
//   the reading/rate shown here.
// - "Demand charge" DOES print its own rate directly (R423.15/kVA most months, R461.28/kVA in June
//   2026) - the rate below is still computed as cost/reading rather than hardcoded, purely so the
//   line reproduces the statement's own cost to the cent after rounding.
//
// Every month's full set of extracted figures reconciles EXACTLY (to the cent) against that
// statement's own printed "Current Charges (Excl. VAT)" / "Current Charges (Including VAT)" figures
// (not "Total Due", which includes any brought-forward balance or small prior-cycle rounding
// carryover - e.g. April 2026 carries a -R0.13 rounding carryover that inflates "Total Due" to
// R373,184.17 vs. this cycle's own R373,184.30 charge).
//
// THREE THINGS FLAGGED BACK TO THE CLIENT (see chat reply) rather than silently smoothed over:
// 1. March 2026's water/sewer section shows a genuine INTERIM REVERSAL: this cycle's own true
//    reading (1,209 kL, an actual read) is billed in full (R86,310.09 water / R63,895.65 sewer at
//    the full reading), but the statement ALSO nets off two credits (-R13,652.00 water,
//    -R21,554.77 sewer) reversing an earlier cycle's over-estimated INTERIM charge (outside this
//    app's tracked window). Recorded here as a blended implied rate against the true 1,209 kL
//    reading so the month's own total still reconciles to the cent, same pattern already used for
//    Bob Martin's Jan 2026 and 8 Field Street's Oct 2025 water.
// 2. June 2026 (the one statement in this batch on the new 2026/2027 tariff year - Property Rates'
//    multiplier steps up from R0.0238620 to R0.0247210, the kVA demand rate from R423.15 to
//    R461.28, Service Charge from R4,246.99 to R4,629.64, Demand Management Levy from R367.86 to
//    R413.84, PIKITUP's levy from R1,047.00 to R1,112.00) is ALSO the one month where all four City
//    Power energy registers show zero consumption (start reading = end reading exactly), yet the
//    Demand charge still bills 167.520 kVA - the same kVA figure March 2026 billed. Looks like City
//    Power's meter genuinely wasn't read this cycle (kVA estimate carried forward, energy usage
//    simply not captured) rather than actual zero consumption - worth confirming with the
//    municipality directly.
// 3. May 2026's electricity section prints TWO rate rows for each of Off-Peak/Peak/Standard (e.g.
//    "Peak charge 7,842.580 kWh @ R2.9539" AND "Peak charge 261.419 kWh @ R7.0291") - a tariff/
//    season change landing mid-reading-period. Modelled directly using this shape's existing _high/
//    _low column pairs (the same columns used for a High/Low winter-demand season split elsewhere in
//    this app) rather than a blended single rate, since the statement already gives exact separate
//    readings/rates for each portion - no approximation needed here.
//
// DATES CORRECTED 2026-08-08 (for the client's over/under-recovery meeting): startDate/endDate below
// used to be calendar-month-rounded (e.g. Dec 2025 was stored as '2025-12-01' to '2026-01-01')
// instead of the statement's own printed "(Reading period = ... = N days)" line - unlike every other
// property's municipal import, which already used each statement's exact electricity reading dates.
// Fixed here to match that same convention. This is purely a display correction - labels didn't
// change, so nothing about which month a statement is filed under (or the Recovery page's label-
// based matching) is affected, only the shown Reading Period text/day-count.
//
// WATER'S OWN READING PERIOD: City of Johannesburg prints Johannesburg Water's reading period
// separately from City Power's electricity period, and they're often genuinely different lengths -
// e.g. Jan 2026's electricity period is 38 days but water is 39 days over a different date range
// entirely (2025-12-19 to 2026-01-26). Every month with extractable statement text now carries its
// own waterStartDate/waterEndDate (see municipal_seed_helpers.js's seedMunicipalStatement) so the
// Recovery page/PDF can show both periods side by side. April and June 2026 are scanned images with
// no extractable text (see each entry's own comment) - left without exact dates for either utility.
//
// Safe to re-run on every boot: each statement is looked up by its unique label ('2025-12' etc) and
// skipped if already present - see municipal_seed_helpers.js.
const { open, migrate } = require('../db');
const { AUTOZONE_COJ_MUNICIPAL } = require('../flat_site_tariff_shapes');
const { seedMunicipalTariff, seedMunicipalStatement } = require('../municipal_seed_helpers');

const TARIFF_NAME = 'City_of_Johannesburg_Municipal_Account_AutoZone';

const MONTHS = [
  // startDate/endDate corrected 2026-08-08 to this statement's own printed electricity reading
  // period (was previously calendar-month-rounded, '2025-12-01' to '2026-01-01') - see file header
  // note on why every other property's municipal import already uses the statement's own exact
  // dates, and the new file-header note below on this fix specifically.
  { label: '2025-12', startDate: '2025-11-26', endDate: '2025-12-25', waterStartDate: '2025-11-26', waterEndDate: '2025-12-18',
    rates: {
      property_rates: 113642.78,
      peak_high: 0, peak_low: 2.9539, standard_high: 0, standard_low: 2.2239, offpeak_high: 0, offpeak_low: 1.7095,
      surcharge_tou: 0, reactive_energy: 0,
      network_surcharge: 3098.94 / 51649, demand_charge: 78578.96 / 185.700, service_charge: 4246.99,
      water: 44616.30 / 630, demand_management_levy: 367.86, sewer: 33295.50 / 630,
      refuse: 1047.00, sundry_surcharge: 1558.24 + 3980.59,
    },
    readings: {
      peak_low: 10681.000, standard_low: 28418.000, offpeak_low: 12550.000,
      reactive_energy: 13669.000,
      network_surcharge: { reading: 51649, comment: 'Total metered kWh (peak+standard+offpeak) this cycle' },
      demand_charge: { reading: 185.700, comment: 'Demand=185.700' },
      water: 630, sewer: 630,
    } },
  { label: '2026-01', startDate: '2025-12-26', endDate: '2026-02-01', waterStartDate: '2025-12-19', waterEndDate: '2026-01-26',
    rates: {
      property_rates: 113642.78,
      peak_high: 0, peak_low: 2.9539, standard_high: 0, standard_low: 2.2239, offpeak_high: 0, offpeak_low: 1.7095,
      surcharge_tou: 0, reactive_energy: 0.4243,
      network_surcharge: 2974.32 / 49572, demand_charge: 75997.74 / 179.600, service_charge: 4246.99,
      water: 76732.76 / 1076, demand_management_levy: 367.86, sewer: 56866.60 / 1076,
      refuse: 1047.00, sundry_surcharge: 2671.99 + 3804.32,
    },
    readings: {
      peak_low: 9547.000, standard_low: 25518.000, offpeak_low: 14507.000,
      reactive_energy: 521.400,
      network_surcharge: { reading: 49572, comment: 'Total metered kWh (peak+standard+offpeak) this cycle' },
      demand_charge: { reading: 179.600, comment: 'Demand=179.600' },
      water: 1076, sewer: 1076,
    } },
  // February 2026: no statement uploaded - gap in the municipal history.
  { label: '2026-03', startDate: '2026-03-02', endDate: '2026-04-01', waterStartDate: '2026-01-27', waterEndDate: '2026-03-28',
    rates: {
      property_rates: 113642.78,
      peak_high: 0, peak_low: 2.9539, standard_high: 0, standard_low: 2.2239, offpeak_high: 0, offpeak_low: 1.7095,
      surcharge_tou: 0, reactive_energy: 0,
      network_surcharge: 2972.88 / 49548, demand_charge: 70886.09 / 167.520, service_charge: 4246.99,
      water: 57690.95 / 1209, demand_management_levy: 367.86, sewer: 42340.88 / 1209,
      refuse: 1047.00, sundry_surcharge: -1003.48 + 3004.11 + 3738.43,
    },
    readings: {
      peak_low: 10623.000, standard_low: 26957.000, offpeak_low: 11968.000,
      reactive_energy: 14313.250,
      network_surcharge: { reading: 49548, comment: 'Total metered kWh (peak+standard+offpeak) this cycle' },
      demand_charge: { reading: 167.520, comment: 'Demand=167.520' },
      water: { reading: 1209, comment: 'NET of this cycle\'s full Step1/Step2 charge (R86,310.09 water / R63,895.65 sewer, both on the true 1,209kL reading) less two INTERIM REVERSAL credits reversing a prior cycle\'s over-estimated INTERIM charge (-R13,652.00 water, -R21,554.77 sewer per statement) - see file header note 1' },
      sewer: { reading: 1209, comment: 'NET of this cycle\'s full Step1/Step2 charge (R86,310.09 water / R63,895.65 sewer, both on the true 1,209kL reading) less two INTERIM REVERSAL credits reversing a prior cycle\'s over-estimated INTERIM charge (-R13,652.00 water, -R21,554.77 sewer per statement) - see file header note 1' },
    } },
  // startDate/endDate left at their calendar-month approximation here (not corrected to the exact
  // reading period like every other month in this file) - this statement is a scanned image with no
  // extractable text (source PDF has no text layer), so the exact reading-period dates can't be
  // re-verified the same way; water's own period is left unset for the same reason.
  { label: '2026-04', startDate: '2026-04-01', endDate: '2026-05-01',
    rates: {
      property_rates: 113642.78,
      peak_high: 0, peak_low: 2.9539, standard_high: 0, standard_low: 2.2239, offpeak_high: 0, offpeak_low: 1.7095,
      surcharge_tou: 0, reactive_energy: 0,
      network_surcharge: 2644.20 / 44070, demand_charge: 73501.16 / 173.700, service_charge: 4246.99,
      water: 22941.29 / 329, demand_management_levy: 367.86, sewer: 17387.65 / 329,
      refuse: 1047.00, sundry_surcharge: 806.58 + 3539.09,
    },
    readings: {
      peak_low: 9277.000, standard_low: 23959.000, offpeak_low: 10834.000,
      reactive_energy: 12549.750,
      network_surcharge: { reading: 44070, comment: 'Total metered kWh (peak+standard+offpeak) this cycle' },
      demand_charge: { reading: 173.700, comment: 'Demand=173.700' },
      water: 329, sewer: 329,
    } },
  { label: '2026-05', startDate: '2026-05-02', endDate: '2026-06-01', waterStartDate: '2026-04-17', waterEndDate: '2026-05-28',
    rates: {
      property_rates: 113642.78,
      peak_high: 7.0291, peak_low: 2.9539, standard_high: 2.6838, standard_low: 2.2239, offpeak_high: 1.8387, offpeak_low: 1.7095,
      surcharge_tou: 0, reactive_energy: 0,
      network_surcharge: 2354.10 / 39235, demand_charge: 79382.94 / 187.600, service_charge: 4246.99,
      water: 149822.91 / 2091, demand_management_levy: 367.86, sewer: 110509.35 / 2091,
      refuse: 1047.00, sundry_surcharge: 5206.65 + 3463.85,
    },
    readings: {
      peak_high: 261.419, peak_low: 7842.580, standard_high: 688.741, standard_low: 20662.258, offpeak_high: 315.483, offpeak_low: 9464.516,
      reactive_energy: 10611.000,
      network_surcharge: { reading: 39235, comment: 'Total metered kWh (peak+standard+offpeak, both rate tranches) this cycle' },
      demand_charge: { reading: 187.600, comment: 'Demand=187.600' },
      water: 2091, sewer: 2091,
    } },
  // Same scanned-PDF limitation as April 2026 above - startDate/endDate left calendar-rounded, no
  // water period recorded.
  { label: '2026-06', startDate: '2026-06-01', endDate: '2026-07-01',
    rates: {
      property_rates: 117733.77,
      peak_high: 0, peak_low: 0, standard_high: 0, standard_low: 0, offpeak_high: 0, offpeak_low: 0,
      surcharge_tou: 0, reactive_energy: 0,
      network_surcharge: 0, demand_charge: 77273.63 / 167.520, service_charge: 4629.64,
      water: 243822.64 / 3393.999, demand_management_levy: 413.84, sewer: 179952.88 / 3393.999,
      refuse: 1112.00, sundry_surcharge: 8475.51 + 1638.07,
    },
    readings: {
      peak_low: 0, standard_low: 0, offpeak_low: 0,
      reactive_energy: 0,
      network_surcharge: { reading: 0, comment: 'Zero - all 4 energy registers show no consumption this cycle, see file header note 2' },
      demand_charge: { reading: 167.520, comment: 'Demand=167.520 (see file header note 2)' },
      water: { reading: 3393.999, comment: 'Combined 3,294.176kL + 99.823kL tranches, mid-cycle rate change - see file header note 2' },
      sewer: { reading: 3393.999, comment: 'Combined 3,294.176kL + 99.823kL tranches, mid-cycle rate change - see file header note 2' },
    } },
];

function main(dbFile = 'autozone.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const m of MONTHS) {
    const tariffId = seedMunicipalTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom: m.startDate, shape: AUTOZONE_COJ_MUNICIPAL, rates: m.rates,
    });
    const slipId = seedMunicipalStatement(db, tariffId, {
      label: m.label, startDate: m.startDate, endDate: m.endDate,
      waterStartDate: m.waterStartDate, waterEndDate: m.waterEndDate, readings: m.readings,
    });
    if (slipId) created++;
  }
  if (created) console.log(`AutoZone municipal account import: ${created} statement(s) added (Dec 2025 - Jun 2026, Feb 2026 and Jul 2026 missing).`);
  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
