// bob-martin/import_history.js - seeds Bob Martin's database with its full known billing history
// (July 2025 - July 2026), taken directly from the client-provided workbook "Other Sites - Past
// billing.xlsx" (tab 'Bob Martin'). Same line-item shape (EKURHULENI_E_TOU in
// flat_site_tariff_shapes.js) as 8 Field Street - just its own rates. Combines what field-street
// splits into seed.js + import_history.js into one script, since here every month (including the
// most recent) comes from the same source workbook rather than a separate reference statement.
//
// TARIFF_NAME below reads "Tariff D1", not "Tariff E", despite reusing the EKURHULENI_E_TOU shape
// constant - client correction 2026-09-04: Bob Martin is actually billed on Ekurhuleni's D1 tariff
// category, not E. This is a display-label fix only (confirmed with the client) - D1 and E share
// the same line-item structure at this municipality, and Bob Martin's own rates already reflect
// what it's actually billed, so nothing here changes except the name shown on the PDF/screen. The
// EKURHULENI_E_TOU shape constant itself is untouched (still shared with 8 Field Street/Cranbrook
// Flavours, which genuinely are on tariff E) - only this site's own TARIFF_NAME string changed.
//
// Correction factors: per the client's instruction, reusing the same 4 factor constants already
// applied to 8 Field Street "for now" - not yet confirmed against Bob Martin's own meters.
//
// Water/Sewer: not billed through this app for this site yet (rate 0, unused) - same as every
// other flat_site property until the client adds readings via the Edit page.
//
// Safe to re-run on every boot (see flat_site_seed_helpers.js): seedUsers/seedTariff/seedSlip are
// all idempotent, so redeploying never duplicates or clobbers anything.
const { open, migrate } = require('../db');
const { seedUsers: seedUsersShared } = require('../shared_seed_users');
const { EKURHULENI_E_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

const TARIFF_NAME = 'Ekurhuleni_Tariff_D1_TOU_Bob Martin';

// Three rate versions found across the 13 months - Jul 2025 - Jan 2026, Feb 2026 - Jun 2026, and
// Jul 2026 (each taken verbatim from that month's statement).
const RATES_A = { // Jul 2025 - Jan 2026
  fixed_charge: 3351.2638, network_access: 114.9369, network_demand: 171.0979,
  peak_high: 11.6178, peak_low: 3.7833, standard_high: 3.3634, standard_low: 2.4736,
  offpeak_high: 2.0632, offpeak_low: 1.8774, water: 0, sewer: 0,
};
const RATES_B = { // Feb 2026 - Jun 2026
  fixed_charge: 3069.24, network_access: 105.9466, network_demand: 158.13,
  peak_high: 10.8065, peak_low: 3.561, standard_high: 3.1578, standard_low: 2.343,
  offpeak_high: 1.9508, offpeak_low: 1.788, water: 0, sewer: 0,
};
const RATES_C = { // Jul 2026
  fixed_charge: 3599.88, network_access: 131.43, network_demand: 153.36,
  peak_high: 7.7211, peak_low: 3.5769, standard_high: 2.4079, standard_low: 2.29,
  offpeak_high: 1.8176, offpeak_low: 1.8176, water: 0, sewer: 0,
};

// label, start_date, end_date, effective_from, rates, network_kva, comment, peak_high, peak_low,
// standard_high, standard_low, offpeak_high, offpeak_low. High/Low Demand Season readings mirror
// the actual statements exactly (winter months bill under "High Demand", the rest "Low Demand").
const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 528.175364, '2025/07/29 21:30', 28223.6351447917, 0, 74660.8598848415, 0, 50384.2054203809, 0],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 508.316212, '2025/08/12 08:00', 18278.5870271508, 0, 47168.4827068183, 0, 30844.2690152682, 0],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 500.437716, '2025/09/04 13:30', 0, 26062.458, 0, 63878.5578000001, 0, 41023.53395],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 501.096892, '2025/10/02 10:00', 0, 28457.7575, 0, 66334.0511, 0, 45284.3338],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 502.225686, '2025/11/17 13:00', 0, 25485.9732, 0, 57356.8576816883, 0, 43445.0408683316],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 477.251804, '2025/12/04 11:30', 0, 6526.39777605384, 0, 17419.2371468466, 0, 14821.5592184425],
  ['2026-01', '2026-01-01', '2026-02-01', '2025-07-01', RATES_A, 481.275392, '2026/01/19 10:30', 0, 17884.6435, 0, 46413.54605, 0, 30922.9418000202],
  ['2026-02', '2026-02-01', '2026-03-01', '2026-02-01', RATES_B, 469.10536, '2026/02/24 19:00', 0, 19939.81285, 0, 50496.8492, 0, 31235.03715],
  ['2026-03', '2026-03-01', '2026-04-01', '2026-02-01', RATES_B, 468.285038, '2026/03/10 14:00', 0, 26660.4399, 0, 59486.0511, 0, 39477.6963],
  ['2026-04', '2026-04-01', '2026-05-01', '2026-02-01', RATES_B, 490.549758, '2026/04/14 13:00', 0, 13599.03755, 0, 32875.93765, 0, 23740.7988],
  ['2026-05', '2026-05-01', '2026-06-01', '2026-02-01', RATES_B, 492.127656, '2026/05/20 21:00', 0, 20775.66345, 0, 48561.085645, 0, 32975.861475],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-02-01', RATES_B, 493.677632, '2026/06/02 21:30', 23917.9965, 0, 59264.60515, 0, 40124.4455, 0],
  ['2026-07', '2026-07-01', '2026-08-01', '2026-07-01', RATES_C, 487.472484, '2026/07/22 20:30', 20906.18375, 0, 49575.36595, 0, 36845.7267, 0],
];

function main(dbFile = 'bob-martin.db') {
  const db = open(dbFile);
  migrate(db);
  if (seedUsersShared(db)) console.log('Seeded users for Bob Martin.');
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
  if (created) console.log(`Bob Martin history import: ${created} month(s) added (Jul 2025 - Jul 2026).`);

  // ---------------------------------------------------------------------------------------------
  // Corrections below: the client's "Bob Martin - past billing V2.xlsx" (uploaded 2026-08-06) is a
  // literal export of the real "Bob Martins Main Incomer" statement for every month Jul 2025-Jul
  // 2026 except Sep 2025 (missing from the workbook, left as this script's original estimate).
  // Cross-checking every row's rate*reading against the sheet's own printed Cost and Total (Ex
  // VAT) figures (all reconcile to the cent) confirmed: every month's rates already matched
  // exactly, and 9 of the 11 months' readings already matched exactly too (Jul-Dec 2025, Jan-Apr
  // 2026, Jun 2026) - only May and July 2026 had different (corrected) readings, and only those
  // two months carry a Water & Sanitation section at all (every other month has none in the source
  // workbook, so stays unbilled at R0 here, same as before). Runs unconditionally every boot, like
  // every other correction block in this project - idempotent (UPDATEs are no-ops once correct).
  // May 2026 shares its tariff (RATES_B, effective 2026-02-01) with Feb/Mar/Apr/Jun, none of which
  // have any water/sewer data of their own in the source workbook - updating water/sewer directly
  // on that shared tariff row would incorrectly put a nonzero rate against those months' still-R0
  // water section too. So May gets its own tariff version instead (identical electrical rates,
  // only water/sewer set), same pattern used for 8 Field Street's per-month tariff corrections.
  const RATES_MAY26 = {
    fixed_charge: 3069.24, network_access: 105.9466, network_demand: 158.13,
    peak_high: 10.8065, peak_low: 3.561, standard_high: 3.1578, standard_low: 2.343,
    offpeak_high: 1.9508, offpeak_low: 1.788, water: 49.11, sewer: 18.91,
  };
  const may26TariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-05-01', shape: EKURHULENI_E_TOU, rates: RATES_MAY26, factors: FACTORS,
    notes: 'Water/sewer confirmed via "Bob Martin - past billing V2.xlsx" for May 2026 only - '
      + 'electrical rates unchanged from RATES_B, just given its own tariff version so April/June '
      + "(still R0/unbilled water) aren't affected.",
  });
  const maySlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-05'").get();
  if (maySlip) {
    db.prepare('UPDATE site_billing_slips SET tariff_id=? WHERE id=?').run(may26TariffId, maySlip.id);
    const maySet = db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key=?");
    maySet.run(499.39500000000004, maySlip.id, 'network_access');
    maySet.run(499.39500000000004, maySlip.id, 'network_demand');
    maySet.run(20999.075558334094, maySlip.id, 'peak_low');
    maySet.run(49083.28964358961, maySlip.id, 'standard_low');
    maySet.run(33330.46900673987, maySlip.id, 'offpeak_low');
    const hasWater = db.prepare("SELECT 1 FROM site_slip_readings WHERE slip_id=? AND item_key='water'").get(maySlip.id);
    if (hasWater) {
      db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(107, maySlip.id);
    } else {
      db.prepare("INSERT INTO site_slip_readings (slip_id, item_key, reading) VALUES (?,?,?)").run(maySlip.id, 'water', 107);
      db.prepare("INSERT INTO site_slip_readings (slip_id, item_key, reading) VALUES (?,?,?)").run(maySlip.id, 'sewer', 107);
    }
  }
  const julSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-07'").get();
  if (julSlip) {
    const julSet = db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key=?");
    julSet.run(494.6710841773542, julSlip.id, 'network_access');
    julSet.run(494.6710841773542, julSlip.id, 'network_demand');
    julSet.run(21130.999414734284, julSlip.id, 'peak_high');
    julSet.run(50108.47706122777, julSlip.id, 'standard_high');
    julSet.run(37241.9490158341, julSlip.id, 'offpeak_high');
    db.prepare("UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key='water'").run(54.51, julSlip.tariff_id);
    db.prepare("UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key='sewer'").run(22.07, julSlip.tariff_id);
    const hasWater = db.prepare("SELECT 1 FROM site_slip_readings WHERE slip_id=? AND item_key='water'").get(julSlip.id);
    if (hasWater) {
      db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(114, julSlip.id);
    } else {
      db.prepare("INSERT INTO site_slip_readings (slip_id, item_key, reading) VALUES (?,?,?)").run(julSlip.id, 'water', 114);
      db.prepare("INSERT INTO site_slip_readings (slip_id, item_key, reading) VALUES (?,?,?)").run(julSlip.id, 'sewer', 114);
    }
  }

  // August 2026: fresh real statement from the client's "Bob Martin Slips August 2026.xlsx" - same
  // rate card as July (RATES_C, including its own water/sewer rates of 54.51/22.07), rate*reading=
  // cost verified exactly for every line, so seeded directly with no correction factor.
  const RATES_AUG26 = {
    fixed_charge: 3599.88, network_access: 131.43, network_demand: 153.36,
    peak_high: 7.7211, peak_low: 3.5769, standard_high: 2.4079, standard_low: 2.29,
    offpeak_high: 1.8176, offpeak_low: 1.8176, water: 54.51, sewer: 22.07,
  };
  const aug26TariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-08-01', shape: EKURHULENI_E_TOU, rates: RATES_AUG26, factors: FACTORS,
    notes: 'Real statement from "Bob Martin Slips August 2026.xlsx", uploaded 2026-09-02 - same '
      + 'rate card as RATES_C (July 2026), rate*reading=cost verified exactly for every electrical '
      + 'and water/sewer line, no correction factor.',
  });
  const aug26SlipId = seedSlip(db, aug26TariffId, {
    label: '2026-08', startDate: '2026-08-01', endDate: '2026-09-01', applyCorrectionFactor: 0,
    readings: {
      network_access: { reading: 485.441766, comment: '2026/08/13 09:00' },
      network_demand: { reading: 485.441766, comment: '2026/08/13 09:00' },
      peak_high: 22857.7077, peak_low: 0, standard_high: 55076.4222, standard_low: 0,
      offpeak_high: 37373.78775, offpeak_low: 0,
      water: 117.7, sewer: 117.7,
    },
  });
  if (aug26SlipId) console.log('Bob Martin: August 2026 slip added.');

  // The client doesn't want the site-meter correction factor applied to any historical import -
  // it should only ever be ticked deliberately, per month, on new slips added going forward via
  // the live "Add Billing Slip" form (default unticked there too - see views.js). Runs
  // unconditionally every boot; a no-op once every slip is already off.
  db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0').run();

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
