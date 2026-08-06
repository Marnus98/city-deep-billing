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
// Water/Sewer: not billed through this app for this site yet (rate 0, unused).
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
const RATES_C = { // Jul 2026: Network Surcharge absent from the statement (see note above)
  service_charge: 2444.32, capacity_charge: 2185.32, demand_charge: 461.28, excess_reactive: 0.4625,
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
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_C, 202.496554, '2026/07/03 10:30', 1888.20808377967, 14946.9746689888, 0, 32731.7474997595, 0, 11734.1737871707, 0, 0, 1],
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

  // The client doesn't want the site-meter correction factor applied to any historical import -
  // it should only ever be ticked deliberately, per month, on new slips added going forward via
  // the live "Add Billing Slip" form (default unticked there too - see views.js). Runs
  // unconditionally every boot; a no-op once every slip is already off.
  db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0').run();

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
