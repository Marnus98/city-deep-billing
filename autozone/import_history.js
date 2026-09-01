// autozone/import_history.js - seeds AutoZone's database with its full known billing history
// (July 2025 - July 2026), taken directly from the client-provided workbook "Other Sites - Past
// billing.xlsx" (tab 'Autozone'). Uses the City Power (City of Johannesburg) Industrial LV TOU
// shape (see flat_site_tariff_shapes.js) - a different municipality entirely from the Ekurhuleni
// sites, with its own Excess Reactive and Network Surcharge line items.
//
// Two source-data quirks resolved here:
// 1. Jan 2026 - Jun 2026 statements merge "Service Charge" and "Capacity Charge" into a single
//    line (confirmed by exact arithmetic: 2242.29 + 2004.7 = 4246.99, the Jan-Jun26 Service Charge
//    rate). Modelled as a genuine tariff-rate change (RATES_B) rather than a shape change: the
//    Capacity Charge item still exists every month, it's just billed at rate 0 / reading 0 for
//    these 6 months, and the Service Charge rate absorbs both.
// 2. Jul 2026's statement has no Network Surcharge line at all. Modelled the same way: the item
//    stays in the shape, rate 0 / reading 0 for that one month.
//
// Correction factors: per the client's instruction, reusing the same 4 factor constants already
// applied to 8 Field Street "for now". Excess Reactive and Network Surcharge get no correction
// factor (factorType: null in the shape) - reactive power and the flat total-energy surcharge
// aren't quantities that factor was calibrated against.
//
// Water/Sewer: Jul-Sep 2025 has no source for these yet (rate 0, unused). Oct 2025 - Jul 2026 now
// bills real water/sewer figures, added via the correction blocks below the MONTHS loop, taken from
// the client's 10 "AutoZone Slips <Month>.xlsx" workbooks (Oct/Nov/Dec 2025 + Jan-Jul 2026) - see
// those blocks' comments for the sliding-scale/blended-rate details. Oct/Nov/Dec 2025's reference
// workbooks also revealed the same Service/Capacity Charge merge bug fixed for July 2026 below -
// see the OCT_DEC_2025 correction block's comment for details. Jul/Aug/Sep 2025 have no reference
// workbook yet, so stay on the original split-line RATES_A style pending one.
//
// Safe to re-run on every boot - see flat_site_seed_helpers.js.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { CITY_POWER_LV_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

const TARIFF_NAME = 'City_Power_Industrial_LV_TOU_AutoZone';

const RATES_A = { // Jul 2025 - Dec 2025
  service_charge: 2242.29, capacity_charge: 2004.7, demand_charge: 423.15, excess_reactive: 0.4243,
  peak_high: 7.0291, peak_low: 2.9539, standard_high: 2.6838, standard_low: 2.2239,
  offpeak_high: 1.8387, offpeak_low: 1.7095, network_surcharge: 0.07, water: 0, sewer: 0,
};
const RATES_B = { // Jan 2026 - Jun 2026: Service + Capacity Charge merged into one line (see note above)
  service_charge: 4246.99, capacity_charge: 0, demand_charge: 423.15, excess_reactive: 0.4243,
  peak_high: 7.0291, peak_low: 2.9539, standard_high: 2.6838, standard_low: 2.2239,
  offpeak_high: 1.8387, offpeak_low: 1.7095, network_surcharge: 0.07, water: 0, sewer: 0,
};
const RATES_C = { // Jul 2026: Network Surcharge absent from the statement (see note above); Service
  // + Capacity Charge stay merged into one line here too (confirmed by the client's "AutoZone Slips
  // July 2026.xlsx" - only one "Service Charge" row is printed, no separate Capacity Charge line -
  // see the correction-block comment below for the bug this replaces).
  service_charge: 4629.64, capacity_charge: 0, demand_charge: 461.28, excess_reactive: 0.4625,
  peak_high: 7.6624, peak_low: 3.22, standard_high: 2.9256, standard_low: 2.4242,
  offpeak_high: 2.0044, offpeak_low: 1.8635, network_surcharge: 0, water: 0, sewer: 0,
};

// label, start_date, end_date, effective_from, rates, demand_kva, comment, excess_reactive,
// peak_high, peak_low, standard_high, standard_low, offpeak_high, offpeak_low, network_surcharge,
// capacity_reading (1 normally, 0 for the 6 merged months).
const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 279.35518, '2025/07/07 08:30', 1153.26881047933, 9694.98466090389, 0, 33754.5153631252, 0, 9753.82584747446, 0, 53203.3258715035, 1],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 255.927378, '2025/08/08 13:00', 1041.9445, 9730.1, 0, 32311.46, 0, 11949.065, 0, 53990.625, 1],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 223.522184, '2025/09/10 12:00', 0, 0, 8415.715, 0, 31141.075, 0, 10700.86, 50257.6500000001, 1],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 223.90456, '2025/09/10 12:00', 0, 0, 8700.76553847568, 0, 32752.8798539447, 0, 10509.4222077488, 51963.0676001692, 1],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 246.455876, '2025/11/17 10:30', 0, 0, 7958.40408311777, 0, 27654.6501383261, 0, 9488.47383561991, 45101.5280570638, 1],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 245.557784, '2025/12/18 11:00', 0, 0, 7261.64979147385, 0, 27450.5564686868, 0, 11021.5529401029, 45733.7592002636, 1],
  ['2026-01', '2026-01-01', '2026-02-01', '2026-01-01', RATES_B, 225.345306, '2026/01/07 15:00', 0, 0, 9033.27000000001, 0, 32708.44, 0, 12256.885, 53998.595, 0],
  ['2026-02', '2026-02-01', '2026-03-01', '2026-01-01', RATES_B, 251.55511, '2026/02/11 09:00', 0, 0, 8599.77, 0, 30534.835, 0, 10882.1242394814, 50016.7292394815, 0],
  ['2026-03', '2026-03-01', '2026-04-01', '2026-01-01', RATES_B, 223.004904, '2026/03/30 16:00', 0, 0, 7570.31, 0, 28204.5475, 0, 11035.295, 46810.1525, 0],
  ['2026-04', '2026-04-01', '2026-05-01', '2026-01-01', RATES_B, 233.30177333333336, '2026/04/21 12:00', 0, 0, 8401.11666666667, 0, 30482.6075, 0, 11391.434746493802, 50275.1589131605, 0],
  ['2026-05', '2026-05-01', '2026-06-01', '2026-01-01', RATES_B, 184.365652, '2026/05/22 10:30', 0, 0, 7240.67495321875, 0, 27099.3198787859, 0, 10888.1029066285, 45228.0977386332, 0],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-01-01', RATES_B, 196.882958, '2026/06/23 09:00', 1962.189142704, 10219.23004909, 0, 32634.789, 0, 11932.33827163, 0, 54786.35732072, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_C, 202.496554, '2026/07/03 10:30', 1888.20808377967, 14946.9746689888, 0, 32731.7474997595, 0, 11734.1737871707, 0, 0, 0],
];

function main(dbFile = 'autozone.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for AutoZone.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, excessReactive, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow, networkSurcharge, capacityReading] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: CITY_POWER_LV_TOU, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        service_charge: 1, capacity_charge: capacityReading,
        demand_charge: { reading: kva, comment },
        excess_reactive: excessReactive,
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow, network_surcharge: networkSurcharge,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`AutoZone history import: ${created} month(s) added (Jul 2025 - Jul 2026).`);

  // ---------------------------------------------------------------------------------------------
  // Corrections below: the client's 7 "AutoZone Slips <Month> 2026.xlsx" workbooks (uploaded
  // 2026-08-07, one per month Jan-Jul 2026) are a literal export of this exact billing slip in our
  // own Entry/Rate/Unit/Reading/Cost shape, including a "Water & Sanitation" table that was never
  // populated for AutoZone before now (water/sewer were rate 0 for every month - see the top-of-
  // file note, now superseded for Jan-Jul 2026 by the blocks below; Jul-Dec 2025 still has no water
  // source and stays at 0).
  //
  // Water bills on a sliding scale (Step 1: first 200kL @ a lower rate, Step 2: the remainder @ a
  // higher rate - same convention as every municipal statement in this app) but this app's schema
  // only supports one flat rate per line item, so - same convention already used for the municipal
  // side's own water blends - the rate stored below is an implied blended rate (cost/reading) that
  // reproduces each month's real sliding-scale total to the cent. Sewer, by contrast, genuinely is
  // a single flat rate every month (R52.85/kL Jan-Jun, confirmed against 6 different consumption
  // volumes all reconciling exactly) - except July, which carries the same new-tariff-year rate
  // bump seen elsewhere in this project (R52.85 -> R58.66, alongside water's Step rates
  // 68.26/72.01 -> 73.72/77.77 and the demand/service rate changes already modelled below).
  //
  // Only water/sewer differ from the already-imported electrical rates for Jan-Jun 2026 (all still
  // match RATES_B exactly) - so each of those 6 months gets its own new tariff version (water rate
  // isolated per month) rather than reusing RATES_B itself, to avoid leaking one month's blended
  // water rate into the other five. July already has its own unique tariff version (RATES_C, one
  // month only), so it's corrected in place instead.
  //
  // ONE BUG ALSO FIXED HERE: RATES_C (July 2026) previously modelled Service Charge as split into
  // two lines (service_charge R2,444.32 + capacity_charge R2,185.32, guessed by projecting the old
  // Jul-Dec 2025 two-line style forward) - the real July workbook shows only ONE "Service Charge"
  // line at R4,629.64, same merged style as every other 2026 month, with no separate Capacity
  // Charge row printed at all. Corrected below: service_charge -> 4,629.64, capacity_charge -> 0,
  // capacity_charge's reading -> 0 (was 1).
  const setReading = db.prepare(`INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,?)
    ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading, comment=excluded.comment`);

  const WATER_MONTHS = [
    // label, effectiveFrom, waterReadingKl, waterCost (sliding-scale total, Step1 200kL@lowRate +
    // Step2 remainder@highRate), sewerRate (flat R/kL)
    //
    // January's effectiveFrom is deliberately '2026-01-02', not '2026-01-01' - the latter is
    // already taken by the original (water=0) RATES_B tariff row seeded above, and seedTariff
    // dedupes purely on (tariff_name, effective_from), ignoring rates - reusing '2026-01-01' here
    // would silently resolve back to that same rate-0 row instead of creating a new one.
    ['2026-01', '2026-01-02', 763, 54193.63, 52.85],
    ['2026-02', '2026-02-01', 668, 47352.68, 52.85],
    ['2026-03', '2026-03-01', 769, 54625.69, 52.85],
    ['2026-04', '2026-04-01', 750.115, 53265.78115, 52.85],
    ['2026-05', '2026-05-01', 776.5695, 55170.769695, 52.85],
    ['2026-06', '2026-06-01', 755.3665, 53643.941665, 52.85],
  ];
  for (const [label, effectiveFrom, waterReadingKl, waterCost, sewerRate] of WATER_MONTHS) {
    const slip = db.prepare('SELECT id, tariff_id FROM site_billing_slips WHERE label=?').get(label);
    if (!slip) continue;
    const newTariffId = seedTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom, shape: CITY_POWER_LV_TOU,
      rates: { ...RATES_B, water: waterCost / waterReadingKl, sewer: sewerRate },
      factors: FACTORS,
      notes: `Water/sewer added from the client's "AutoZone Slips ${label}.xlsx" - electrical rates unchanged from RATES_B.`,
    });
    db.prepare('UPDATE site_billing_slips SET tariff_id=?, apply_correction_factor=0 WHERE id=?').run(newTariffId, slip.id);
    setReading.run(slip.id, 'water', waterReadingKl, null);
    setReading.run(slip.id, 'sewer', waterReadingKl, null);
  }

  // ---------------------------------------------------------------------------------------------
  // Oct/Nov/Dec 2025 corrections: the client's 3 "AutoZone Slips <Month> 2025.xlsx" reference
  // workbooks (uploaded 2026-08-07) confirm every electrical reading/rate already seeded above for
  // these 3 months (from RATES_A) matches exactly - no electricity changes needed. Two things don't
  // match though:
  // 1. Water/Sewer were never billed for these months (rate 0) - now added below, same sliding-
  //    scale/blended-rate convention as WATER_MONTHS above (Step1 200kL@68.26 + Step2 remainder@
  //    72.01 for water, flat R52.85/kL for sewer - both reconcile to the cent against each
  //    workbook's own printed sliding-scale totals).
  // 2. The workbooks each show a single merged "Service Charge: R4,246.99" line - not the split
  //    `service_charge: 2242.29 + capacity_charge: 2004.70` RATES_A currently models (same total
  //    either way, since 2242.29 + 2004.70 = 4246.99 exactly, but the wrong line-item split - the
  //    same bug already found and fixed for RATES_C/July 2026 above). Corrected below to the merged
  //    style for these 3 specific months only, since that's what their reference workbooks show.
  //    Jul/Aug/Sep 2025 have no reference workbook yet, so are left on the original split style
  //    pending one - RATES_A itself is untouched; these 3 months get their own new tariff versions.
  const OCT_DEC_2025_MONTHS = [
    // label, effectiveFrom, waterReadingKl, waterCost (sliding-scale total), sewerRate (flat R/kL)
    ['2025-10', '2025-10-01', 727.463, 51634.61063, 52.85],
    ['2025-11', '2025-11-01', 733.1745, 52045.895745, 52.85],
    ['2025-12', '2025-12-01', 785, 55777.85, 52.85],
  ];
  for (const [label, effectiveFrom, waterReadingKl, waterCost, sewerRate] of OCT_DEC_2025_MONTHS) {
    const slip = db.prepare('SELECT id, tariff_id FROM site_billing_slips WHERE label=?').get(label);
    if (!slip) continue;
    const newTariffId = seedTariff(db, {
      tariffName: TARIFF_NAME, effectiveFrom, shape: CITY_POWER_LV_TOU,
      rates: { ...RATES_A, service_charge: 4246.99, capacity_charge: 0, water: waterCost / waterReadingKl, sewer: sewerRate },
      factors: FACTORS,
      notes: `Water/sewer added and Service/Capacity Charge merged from the client's "AutoZone Slips ${label}.xlsx" - other electrical rates unchanged from RATES_A.`,
    });
    db.prepare('UPDATE site_billing_slips SET tariff_id=?, apply_correction_factor=0 WHERE id=?').run(newTariffId, slip.id);
    setReading.run(slip.id, 'capacity_charge', 0, null);
    setReading.run(slip.id, 'water', waterReadingKl, null);
    setReading.run(slip.id, 'sewer', waterReadingKl, null);
  }

  const julSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-07'").get();
  if (julSlip) {
    const julRate = db.prepare('UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key=?');
    julRate.run(4629.64, julSlip.tariff_id, 'service_charge');
    julRate.run(0, julSlip.tariff_id, 'capacity_charge');
    julRate.run(58454.78404 / 762.052, julSlip.tariff_id, 'water');
    julRate.run(58.66, julSlip.tariff_id, 'sewer');
    setReading.run(julSlip.id, 'capacity_charge', 0, null);
    setReading.run(julSlip.id, 'water', 762.052, null);
    setReading.run(julSlip.id, 'sewer', 762.052, null);
  }

  // August 2026: fresh real statement from the client's "AutoZone Slips Aug 2026.xlsx" -
  // rate*reading=cost verified to the cent for every electrical line, so seeded directly with
  // apply_correction_factor off, same as every real-statement month since Jan 2026.
  //
  // Water/Sewer flag: this month's Water Consumption (762.052 kL, cost R58,454.78) and Sewer
  // (762.052 kL @ R58.66) are BYTE-IDENTICAL to July 2026's already-seeded figures above
  // (julRate.run(58454.78404 / 762.052, ...) / julSet water/sewer reading 762.052) - suspicious
  // for two different months' real meter readings to match to 3 decimal places. Likely the
  // client's workbook template carried July's water figures forward without updating them for
  // August, rather than a genuine reading. Seeded as given (matching the "trust the uploaded
  // workbook, let the client correct via the Edit page" convention used throughout this file)
  // but flagged here and in the delivery summary - worth the client double-checking the actual
  // August water meter reading.
  const RATES_AUG26 = {
    service_charge: 4629.64, capacity_charge: 0, demand_charge: 461.28, excess_reactive: 0.4625,
    peak_high: 7.6624, peak_low: 3.22, standard_high: 2.9256, standard_low: 2.4242,
    offpeak_high: 2.0044, offpeak_low: 1.8635, network_surcharge: 0,
    water: 58454.78404 / 762.052, sewer: 58.66,
  };
  const aug26TariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-08-01', shape: CITY_POWER_LV_TOU, rates: RATES_AUG26, factors: FACTORS,
    notes: 'Real statement from "AutoZone Slips Aug 2026.xlsx", uploaded 2026-09-01 - rate*reading'
      + '=cost verified exactly for every electrical line, no correction factor. Water/Sewer '
      + 'reading (762.052 kL) is identical to July 2026\'s - possibly a stale/carried-forward '
      + 'workbook figure rather than a fresh August reading; flagged for the client to confirm.',
  });
  const aug26SlipId = seedSlip(db, aug26TariffId, {
    label: '2026-08', startDate: '2026-08-01', endDate: '2026-09-01', applyCorrectionFactor: 0,
    readings: {
      service_charge: 1, capacity_charge: 0,
      demand_charge: { reading: 208.234494, comment: '2026/08/12 10:30' },
      excess_reactive: 1466.782,
      peak_high: 12417.02, peak_low: 0,
      standard_high: 29014.395, standard_low: 0,
      offpeak_high: 12028.74, offpeak_low: 0,
      network_surcharge: 0,
      water: 762.052, sewer: 762.052,
    },
  });
  if (aug26SlipId) console.log('AutoZone: August 2026 slip added.');

  // The client doesn't want the site-meter correction factor applied to any historical import -
  // it should only ever be ticked deliberately, per month, on new slips added going forward via
  // the live "Add Billing Slip" form (default unticked there too - see views.js). Runs
  // unconditionally every boot; a no-op once every slip is already off.
  db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0').run();

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
