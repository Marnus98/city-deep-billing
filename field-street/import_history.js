// field-street/import_history.js - one-time bulk import of 8 Field Street's electricity billing
// history (July 2025 - June 2026), taken directly from the client-provided workbook
// "8 field test - past billing.xlsx" (12 monthly "8 Field Street Main Electrical" statements, same
// Ekurhuleni TOU shape as seed.js's July 2026 tariff). July 2026 onward is already covered by
// seed.js / the live "Add Billing Slip" form, so this script stops at June 2026.
//
// Water/Sewer: the client entered these by hand on the live site (Edit page) after this script's
// electricity-only first pass. To stop that manual entry being lost if the (currently unpaid,
// ephemeral-disk) Render instance ever resets before a persistent disk is attached, the water_kl
// readings below were reverse-engineered from the client's own downloaded PDF (trend chart pages -
// "8-field-street-2026-07 (1).pdf", Aug 2025 - Jun 2026 window) and folded back into this script as
// the new baseline. Water/Sewer use one meter reading for both lines (matches every statement seen
// for this site), and the reading itself is precise to the nearest displayed kL - fine for the
// consumption figure, but the two rate figures (49.15 R/kL water, 18.93 R/kL sewer) are back-solved
// from rounded Rand totals on the same PDF, not read off a source statement - flagged as
// best-effort; ask the client to confirm/correct via the Edit page if these look off. July 2025 is
// outside that PDF's 12-month trailing chart window, so its water_kl is still 0 pending the actual
// figure.
//
// Safe to re-run on every boot (same pattern as seed_municipal.js): each month is looked up by its
// unique label ('2025-07' etc) and skipped if already present, so redeploying never duplicates or
// clobbers a slip the client has since edited by hand - this only re-creates a month from scratch
// if it's missing entirely (e.g. after a filesystem reset wiped it).
const { open, migrate } = require('../db');
const { EKURHULENI_E_TOU } = require('../flat_site_tariff_shapes');
const { seedTariff, seedSlip } = require('../flat_site_seed_helpers');

const FACTORS = { kva_factor: 1.038681688, peak_factor: 1.017448464, standard_factor: 1.017563209, offpeak_factor: 1.017174764 };

// Water/sewer rate that applied Aug 2025 - Jun 2026, per the client's live PDF (see note above) -
// a single, distinct era from the current 54.51/22.07 rate that took over from Jul 2026.
const WATER_RATE_HISTORIC = 49.15;
const SEWER_RATE_HISTORIC = 18.93;

const TARIFF_NAME = 'Ekurhuleni_Tariff_E_TOU_8 Field Street';

// Two rate versions found across the 12 months - the tariff changed once, effective Feb 2026.
const RATES_A = { // Jul 2025 - Jan 2026
  fixed_charge: 5694.3279, network_access: 107.5628, network_demand: 161.8608,
  peak_high: 11.4252, peak_low: 3.7132, standard_high: 3.3047, standard_low: 2.4231,
  offpeak_high: 2.0192, offpeak_low: 1.8357, water: WATER_RATE_HISTORIC, sewer: SEWER_RATE_HISTORIC,
};
const RATES_B = { // Feb 2026 - Jun 2026
  fixed_charge: 5207.09, network_access: 105.9466, network_demand: 146.09,
  peak_high: 10.486, peak_low: 3.415, standard_high: 3.036, standard_low: 2.231,
  offpeak_high: 1.848, offpeak_low: 1.693, water: WATER_RATE_HISTORIC, sewer: SEWER_RATE_HISTORIC,
};

// label, start_date, end_date, effective_from (of RATES_A/RATES_B), rates, network_kva, comment,
// peak_high, peak_low, standard_high, standard_low, offpeak_high, offpeak_low, water_kl (also used
// for sewer_kl). High/Low Demand Season readings mirror the actual statements exactly (winter
// months bill under "High Demand", the rest under "Low Demand").
const MONTHS = [
  ['2025-07', '2025-07-01', '2025-08-01', '2025-07-01', RATES_A, 587.576762, '2025/07/11 07:00', 47510.48, 0, 99886.55, 0, 115380.42, 0, 0],
  ['2025-08', '2025-08-01', '2025-09-01', '2025-07-01', RATES_A, 590.287186, '2025/08/13 21:00', 38622.49, 0, 84308.26, 0, 122621.9, 0, 204],
  ['2025-09', '2025-09-01', '2025-10-01', '2025-07-01', RATES_A, 600.921836, '2025/09/10 22:00', 0, 46140.52, 0, 107174.03, 0, 147138.53, 206],
  ['2025-10', '2025-10-01', '2025-11-01', '2025-07-01', RATES_A, 592.437368, '2025/10/22 21:00', 0, 49665.88, 0, 107005.79, 0, 138035.11, 218],
  ['2025-11', '2025-11-01', '2025-12-01', '2025-07-01', RATES_A, 587.63589, '2025/11/27 20:30', 0, 40347.68, 0, 93869.99, 0, 125695.44, 122],
  ['2025-12', '2025-12-01', '2026-01-01', '2025-07-01', RATES_A, 576.463398, '2025/12/04 20:00', 0, 30983.01, 0, 76012.39, 0, 108748.62, 168],
  ['2026-01', '2026-01-01', '2026-02-01', '2025-07-01', RATES_A, 595.787268, '2026/01/29 22:00', 0, 40917.38, 0, 88116.32, 0, 113724.34, 155],
  ['2026-02', '2026-02-01', '2026-03-01', '2026-02-01', RATES_B, 569.79913, '2026/02/10 19:00', 0, 37054.89, 0, 78921.15, 0, 102771.76, 138],
  ['2026-03', '2026-03-01', '2026-04-01', '2026-02-01', RATES_B, 608.312344, '2026/03/10 21:30', 0, 42599.81, 0, 92221.79, 0, 117336, 191],
  ['2026-04', '2026-04-01', '2026-05-01', '2026-02-01', RATES_B, 596.817086, '2026/04/29 07:00', 0, 41631.11, 0, 95711.72, 0, 139319.34, 218],
  ['2026-05', '2026-05-01', '2026-06-01', '2026-02-01', RATES_B, 594.15233, '2026/05/07 21:30', 0, 45649.32, 0, 103848.27, 0, 139985.44, 214],
  ['2026-06', '2026-06-01', '2026-07-01', '2026-02-01', RATES_B, 580.191224, '2026/06/04 21:30', 41161.79, 0, 93587.11, 0, 114716.57, 0, 196],
];

function main(dbFile = 'field-street.db') {
  const db = open(dbFile);
  migrate(db);
  let created = 0;
  for (const [label, startDate, endDate, effectiveFrom, rates, kva, comment, peakHigh, peakLow, stdHigh, stdLow, offHigh, offLow, waterKl] of MONTHS) {
    const tariffId = seedTariff(db, { tariffName: TARIFF_NAME, effectiveFrom, shape: EKURHULENI_E_TOU, rates, factors: FACTORS });
    const slipId = seedSlip(db, tariffId, {
      label, startDate, endDate,
      readings: {
        network_access: { reading: kva, comment }, network_demand: { reading: kva, comment },
        peak_high: peakHigh, peak_low: peakLow, standard_high: stdHigh, standard_low: stdLow,
        offpeak_high: offHigh, offpeak_low: offLow, water: waterKl, sewer: waterKl,
      },
    });
    if (slipId) created++;
  }
  if (created) console.log(`8 Field Street history import: ${created} month(s) added (Jul 2025 - Jun 2026).`);

  // One-off correction for the July 2026 slip: the client corrected the water/sewer tariff to
  // R49.11/kL water, R18.91/kL sewer (the reference statement's R54.51/R22.07 was wrong) and asked
  // for the meter reading to be adjusted rather than the bill total - so 222.48 kL is back-solved
  // to keep the Water & Sanitation section at the same R15,132.97 total the client had already
  // seen, under the corrected rates. seed.js already plants these correct values on a brand-new
  // database, but a database seeded before this correction (i.e. the live site) never re-runs
  // seed.js - so this UPDATE runs unconditionally every boot (like the rest of this script) to
  // reach it too. Idempotent: setting fixed values is a no-op once already correct.
  const julSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-07'").get();
  if (julSlip) {
    db.prepare("UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key='water'").run(49.11, julSlip.tariff_id);
    db.prepare("UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key='sewer'").run(18.91, julSlip.tariff_id);
    db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(222.48, julSlip.id);
  }

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
