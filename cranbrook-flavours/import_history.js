// cranbrook-flavours/import_history.js - seeds Cranbrook Flavours' database with its full known
// billing history (July 2025 - July 2026), taken directly from the client-provided workbook
// "Other Sites - Past billing.xlsx" (tab 'Cranbrook Flavours'). Same Ekurhuleni Tariff E TOU shape
// as 8 Field Street (see flat_site_tariff_shapes.js) - rates for Jul 2025 - Jun 2026 happen to be
// numerically identical to 8 Field Street's own RATES_A for the same period (same municipal
// tariff, same era), Jul 2026 is its own site-specific rate (client statement labels the fixed fee
// "Service Charge" that month instead of "Fixed Charge", but it's the same tariff item/key).
//
// Correction factors: per the client's instruction, reusing the same 4 factor constants already
// applied to 8 Field Street "for now".
//
// Water/Sewer, Jul-Dec 2025: not billed through this app for this site yet (rate 0, unused) - no
// source workbook has been provided for these 6 months.
//
// Water/Sewer, Jan-Jul 2026 - added 2026-08-20 from 7 client-provided workbooks ("Cranbrook
// Flavours - Tunney Slips <Month> 2026.xlsx"), which surfaced two real corrections against what had
// been seeded here before (both confirmed with the client 2026-08-20, all 7 months already
// "finalised" in the app at the time):
//   - Water was billed every one of these 7 months (49.11 R/kL Jan-Jun, 54.51 R/kL Jul, matching the
//     same tariff-year rate change seen on every other Ekurhuleni site in this app) - simply never
//     wired into this site's own historical import before now.
//   - Sewer wasn't billed at all Jan-May 2026 (rate 0 on the client's own statements those months,
//     same as it's always been in this app), but genuinely starts being billed from June 2026
//     onward (18.91 R/kL Jun, 22.07 R/kL Jul) - not a correction to a past assumption, a real
//     mid-year change on the account.
//   - June 2026 also turned out to have a completely different electricity rate card than every
//     other Jul 2025 - Jun 2026 month (lower Fixed Charge/Network Access/Network Demand/TOU energy
//     rates all round) - the historical import had been charging June at the same rate as every
//     other month in that run, which the client's own June workbook shows is wrong. See RATES_JAN_MAY26
//     and RATES_JUN26 below for the 2 new tariff versions this required (Jan-May26 needed its own
//     version purely for the water rate turning on; June needed one for the electricity rate change
//     too) - Jul 2025 - Dec 2025 (tariff v1, RATES_A) is untouched, since no workbook covers it.
//
// Safe to re-run on every boot - see flat_site_seed_helpers.js.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_E_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

const TARIFF_NAME = 'Ekurhuleni_Tariff_E_TOU_Cranbrook Flavours';

// Two rate versions - Jul 2025 - Jun 2026, then Jul 2026.
const RATES_A = { // Jul 2025 - Jun 2026
  fixed_charge: 5694.3279, network_access: 107.5628, network_demand: 161.8608,
  peak_high: 11.4252, peak_low: 3.7132, standard_high: 3.3047, standard_low: 2.4231,
  offpeak_high: 2.0192, offpeak_low: 1.8357, water: 0, sewer: 0,
};
const RATES_B = { // Jul 2026
  fixed_charge: 5676.25, network_access: 105.33, network_demand: 159.25,
  peak_high: 11.4354, peak_low: 3.7227, standard_high: 3.3142, standard_low: 2.4324,
  offpeak_high: 2.0286, offpeak_low: 1.8451, water: 0, sewer: 0,
};

const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 92.254426, '2025/07/23 10:30', 565.472, 0, 3312.7849, 0, 973.086300000001, 0],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 60.279304, '2025/08/01 10:30', 450.51785, 0, 2678.99015, 0, 983.0612, 0],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 85.348078, '2025/09/23 13:00', 0, 599.62815, 0, 3050.64975, 0, 892.036730000001],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 71.393448, '2025/10/14 10:00', 0, 532.61365, 0, 2877.8943, 0, 876.733249999999],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 78.706928, '2025/11/05 10:00', 0, 649.17675, 0, 3032.14375, 0, 982.2294],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 37.035944, '2026/01/08 09:30', 0, 188.01175, 0, 626.1455, 0, 595.77628],
  ['2026-01', '2026-01-01', '2026-02-01', '2025-07-01', RATES_A, 41.823744, '2026/01/15 09:30', 0, 463.36855, 0, 1425.81625, 0, 665.66125],
  ['2026-02', '2026-02-01', '2026-03-01', '2025-07-01', RATES_A, 54.038514, '2026/02/07 10:00', 0, 644.0784, 0, 2037.9676, 0, 982.4456],
  ['2026-03', '2026-03-01', '2026-04-01', '2025-07-01', RATES_A, 52.562974, '2026/03/19 15:30', 0, 579.4178, 0, 2345.284505, 0, 994.4723],
  ['2026-04', '2026-04-01', '2026-05-01', '2025-07-01', RATES_A, 53.474346, '2026/04/10 10:00', 0, 589.222, 0, 2007.9469, 0, 733.21535],
  ['2026-05', '2026-05-01', '2026-06-01', '2025-07-01', RATES_A, 49.427456, '2026/05/15 13:30', 0, 593.249, 0, 2267.4834, 0, 778.807350000001],
  ['2026-06', '2026-06-01', '2026-07-01', '2025-07-01', RATES_A, 55.521416, '2026/06/10 13:30', 480.5944, 0, 2497.2823, 0, 673.69355, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_B, 60.450586, '2026/07/14 14:30', 481.7269, 0, 2495.0006, 0, 669.00425, 0],
];

function main(dbFile = 'cranbrook-flavours.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for Cranbrook Flavours.');
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: EKURHULENI_E_TOU, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        network_access: { reading: kva, comment }, network_demand: { reading: kva, comment },
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`Cranbrook Flavours history import: ${created} month(s) added (Jul 2025 - Jul 2026).`);

  // Jan-May 2026: water turns on this tariff-year (49.11 R/kL), sewer stays at 0 (matches the
  // client's own 7 workbooks) - genuinely different from RATES_A's water=0/sewer=0, so these 5
  // months need their own tariff version rather than sharing tariff v1 with Jul-Dec 2025 (which no
  // workbook covers yet, so it's left as-is). Electricity rates are otherwise identical to RATES_A.
  const RATES_JAN_MAY26 = { ...RATES_A, water: 49.11, sewer: 0 };
  const janMayTariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-01-01', shape: EKURHULENI_E_TOU, rates: RATES_JAN_MAY26, factors: FACTORS,
    notes: 'Same electricity rates as RATES_A (Jul 2025 - Jun 2026) - only water turns on this '
      + 'version (49.11 R/kL), confirmed against the client-provided "Cranbrook Flavours - Tunney '
      + 'Slips <Month> 2026.xlsx" workbooks for Jan-May 2026. Sewer stays R0 (not billed).',
  });
  const janMayReadings = { '2026-01': 163, '2026-02': 232, '2026-03': 210, '2026-04': 312, '2026-05': 203 };
  for (const [label, kl] of Object.entries(janMayReadings)) {
    const slip = db.prepare('SELECT id FROM site_billing_slips WHERE label=?').get(label);
    if (slip) {
      db.prepare('UPDATE site_billing_slips SET tariff_id=? WHERE id=?').run(janMayTariffId, slip.id);
      db.prepare('INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,NULL) '
        + 'ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading').run(slip.id, 'water', kl);
      db.prepare('INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,NULL) '
        + 'ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading').run(slip.id, 'sewer', kl);
    }
  }

  // June 2026: the client's own June workbook shows a genuinely different electricity rate card
  // from every other Jul 2025 - Jun 2026 month (lower Fixed Charge/Network Access/Network Demand/TOU
  // energy rates all round) - the historical import above had been charging June at RATES_A, which
  // this replaces. Sewer also starts being billed this month (18.91 R/kL) alongside water (49.11
  // R/kL, same rate as Jan-May). Readings (kVA/kWh) are unchanged from what MONTHS already seeded
  // above - only the rates and the water/sewer readings need correcting.
  const RATES_JUN26 = {
    fixed_charge: 5207.09, network_access: 105.9466, network_demand: 146.09,
    peak_high: 10.486, peak_low: 3.415, standard_high: 3.036, standard_low: 2.231,
    offpeak_high: 1.848, offpeak_low: 1.693, water: 49.11, sewer: 18.91,
  };
  const junTariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-06-01', shape: EKURHULENI_E_TOU, rates: RATES_JUN26, factors: FACTORS,
    notes: 'Actual rates from the client-provided "Cranbrook Flavours - Tunney Slips June 2026 - '
      + 'V2.xlsx" workbook - a genuinely different, lower rate card than every other Jul 2025 - Jun '
      + '2026 month, plus sewer billing starting this month (18.91 R/kL).',
  });
  const junSlip = db.prepare("SELECT id FROM site_billing_slips WHERE label='2026-06'").get();
  if (junSlip) {
    db.prepare('UPDATE site_billing_slips SET tariff_id=? WHERE id=?').run(junTariffId, junSlip.id);
    db.prepare('INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,NULL) '
      + 'ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading').run(junSlip.id, 'water', 306);
    db.prepare('INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,NULL) '
      + 'ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading').run(junSlip.id, 'sewer', 306);
  }

  // July 2026: already its own dedicated tariff version (RATES_B, tariff_id unique to this slip, not
  // shared with any other month) - just needs its water/sewer *rates* filled in (54.51/22.07,
  // matching the same tariff-year rate change seen elsewhere in this app) and its water/sewer
  // reading set, from the client-provided "Cranbrook Flavours - Tunney Slips July 2026 - V2.xlsx".
  const julSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-07'").get();
  if (julSlip) {
    const julRate = db.prepare('UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key=?');
    julRate.run(54.51, julSlip.tariff_id, 'water');
    julRate.run(22.07, julSlip.tariff_id, 'sewer');
    db.prepare('INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,NULL) '
      + 'ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading').run(julSlip.id, 'water', 211);
    db.prepare('INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,NULL) '
      + 'ON CONFLICT(slip_id, item_key) DO UPDATE SET reading=excluded.reading').run(julSlip.id, 'sewer', 211);
  }

  // The client doesn't want the site-meter correction factor applied to any historical import -
  // it should only ever be ticked deliberately, per month, on new slips added going forward via
  // the live "Add Billing Slip" form (default unticked there too - see views.js). Runs
  // unconditionally every boot; a no-op once every slip is already off.
  db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0').run();

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
