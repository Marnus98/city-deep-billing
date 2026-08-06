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

  // ---------------------------------------------------------------------------------------------
  // Corrections below: the client's "8 field test - past billing V2.xlsx" (uploaded 2026-08-06)
  // is a literal export of the real "8 Field Street Main Electrical" statement for March, April,
  // May, June and July 2026, in the exact Entry/Rate/Unit/Reading/Cost/Comment shape our own PDF
  // uses. Cross-checking every row's rate*reading against the sheet's own printed Cost and Total
  // (Excl VAT)/Sub Total figures (all reconcile to the cent) revealed the sheet's "Reading" column
  // is the *unadjusted* figure - i.e. for these 5 months apply_correction_factor must be OFF, not
  // the seedSlip default of ON, or the app was silently grossing up an already-correct reading by
  // the ~1.7-3.9% kva/peak/standard/offpeak factors and overstating the bill. (The correction
  // factor concept still applies as originally intended to every *other* month - Jul 2025-Feb 2026
  // - where we only ever had the site's own submeter estimate, not the real statement.)
  //
  // Each block below is idempotent and runs unconditionally every boot, like the rest of this
  // script (UPDATEs are no-ops once already correct; seedTariff dedupes by
  // tariff_name+effective_from) - necessary because seed.js/the MONTHS loop above only ever insert
  // once and a live (already-seeded) database never re-runs them.

  // March / April / May 2026: same electrical rates as RATES_B (fixed_charge, network_access,
  // network_demand, and every peak/standard/off-peak rate all match RATES_B exactly) - only
  // water/sewer differs (R49.11/R18.91, not RATES_B's R49.15/R18.93 historic back-solved guess) -
  // so these three months share one new tariff version rather than RATES_B itself, to avoid
  // touching February (still an unconfirmed estimate). March and April's electrical readings
  // already matched the real statement exactly (no factor needed); May's raw kVA/peak/standard/
  // off-peak readings were themselves off (a bad historic estimate) and are corrected below too.
  const RATES_MAR_APR_MAY26 = {
    fixed_charge: 5207.09, network_access: 105.9466, network_demand: 146.09,
    peak_high: 10.486, peak_low: 3.415, standard_high: 3.036, standard_low: 2.231,
    offpeak_high: 1.848, offpeak_low: 1.693, water: 49.11, sewer: 18.91,
  };
  const marAprMayTariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-03-01', shape: EKURHULENI_E_TOU, rates: RATES_MAR_APR_MAY26, factors: FACTORS,
    notes: 'Actual water/sewer rate (R49.11/R18.91) confirmed via the client\'s "8 field test - past '
      + 'billing V2.xlsx" for March-May 2026, replacing the RATES_B back-solved historic guess '
      + '(R49.15/R18.93) for these 3 months. Electrical rates unchanged from RATES_B.',
  });
  const marSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-03'").get();
  if (marSlip) {
    db.prepare('UPDATE site_billing_slips SET tariff_id=?, apply_correction_factor=0 WHERE id=?').run(marAprMayTariffId, marSlip.id);
    db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(190.685, marSlip.id);
  }
  const aprSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-04'").get();
  if (aprSlip) {
    db.prepare('UPDATE site_billing_slips SET tariff_id=?, apply_correction_factor=0 WHERE id=?').run(marAprMayTariffId, aprSlip.id);
    db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(217.735, aprSlip.id);
  }
  const maySlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-05'").get();
  if (maySlip) {
    db.prepare('UPDATE site_billing_slips SET tariff_id=?, apply_correction_factor=0 WHERE id=?').run(marAprMayTariffId, maySlip.id);
    db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(214.36, maySlip.id);
    const maySet = db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key=?");
    maySet.run(617.0271947049999, maySlip.id, 'network_access');
    maySet.run(617.0271947049999, maySlip.id, 'network_demand');
    maySet.run(46446.34727079082, maySlip.id, 'peak_low');
    maySet.run(105661.43837171832, maySlip.id, 'standard_low');
    maySet.run(142429.55555733255, maySlip.id, 'offpeak_low');
  }

  // June 2026: same fix as March/April/May (turn correction factor OFF), plus June already needed
  // its own genuinely different tariff (see RATES_JUN26 below, set in an earlier pass) - the
  // reading values here replace the raw-pre-factor figures previously stored (580.191224 etc,
  // which only worked because they were deliberately back-computed as reading/factor - simpler and
  // less fragile to just store the real reading directly and turn the factor off, matching every
  // other corrected month).
  const RATES_JUN26 = {
    fixed_charge: 6195.35, network_access: 101.1166, network_demand: 146.09,
    peak_high: 10.4902, peak_low: 3.4150, standard_high: 3.0403, standard_low: 2.2310,
    offpeak_high: 1.8609, offpeak_low: 1.6930, water: 49.65, sewer: 19.226,
  };
  const jun26TariffId = seedTariff(db, {
    tariffName: TARIFF_NAME, effectiveFrom: '2026-06-01', shape: EKURHULENI_E_TOU, rates: RATES_JUN26, factors: FACTORS,
    notes: 'Actual rates from the client-provided "8 Field Street Main Electrical" statement for the '
      + 'period 2026-06-01 to 2026-07-01, replacing the earlier RATES_B estimate for this one month.',
  });
  const junSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-06'").get();
  if (junSlip) {
    db.prepare('UPDATE site_billing_slips SET tariff_id=?, apply_correction_factor=0 WHERE id=?').run(jun26TariffId, junSlip.id);
    const junSet = db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key=?");
    junSet.run(602.634, junSlip.id, 'network_access');
    junSet.run(602.634, junSlip.id, 'network_demand');
    junSet.run(41880, junSlip.id, 'peak_high');
    junSet.run(95230.8, junSlip.id, 'standard_high');
    junSet.run(116686.8, junSlip.id, 'offpeak_high');
    db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(193, junSlip.id);
  }

  // July 2026: seed.js planted this slip with rates/readings rounded to 2 decimal places (taken
  // from the original reference image) and the seedSlip default of apply_correction_factor ON,
  // which was silently grossing up an already-correct reading - same bug as March/April/June
  // above. Full-precision rates/readings below come straight from the V2 workbook. Water/sewer are
  // deliberately NOT reset to the V2 sheet's R54.51/R22.07/197.61kL here - the client explicitly
  // corrected those to R49.11/R18.91 with a 222.48kL reading earlier in this project (see the
  // water/sewer note at the top of this file), and that correction stands.
  const julSlip = db.prepare("SELECT id, tariff_id FROM site_billing_slips WHERE label='2026-07'").get();
  if (julSlip) {
    const julRate = db.prepare("UPDATE site_tariff_items SET rate=? WHERE tariff_id=? AND item_key=?");
    julRate.run(11.4354, julSlip.tariff_id, 'peak_high');
    julRate.run(3.7227, julSlip.tariff_id, 'peak_low');
    julRate.run(3.3142, julSlip.tariff_id, 'standard_high');
    julRate.run(2.4324, julSlip.tariff_id, 'standard_low');
    julRate.run(2.0286, julSlip.tariff_id, 'offpeak_high');
    julRate.run(1.8451, julSlip.tariff_id, 'offpeak_low');
    julRate.run(49.11, julSlip.tariff_id, 'water');
    julRate.run(18.91, julSlip.tariff_id, 'sewer');
    db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0 WHERE id=?').run(julSlip.id);
    const julSet = db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key=?");
    julSet.run(628.48638795, julSlip.id, 'network_access');
    julSet.run(628.48638795, julSlip.id, 'network_demand');
    julSet.run(54891.82308157098, julSlip.id, 'peak_high');
    julSet.run(117534.54287771918, julSlip.id, 'standard_high');
    julSet.run(140252.84279365416, julSlip.id, 'offpeak_high');
    db.prepare("UPDATE site_slip_readings SET reading=? WHERE slip_id=? AND item_key IN ('water','sewer')").run(222.48, julSlip.id);
  }

  // The client doesn't want the site-meter correction factor applied to any historical import -
  // it should only ever be ticked deliberately, per month, on new slips added going forward via
  // the live "Add Billing Slip" form (default unticked there too - see views.js). The blocks above
  // already turn it off month-by-month for Mar-Jul 2026; this blanket UPDATE catches every other
  // month too (Jul 2025 - Feb 2026, still on the seedSlip default of ON until now). Runs
  // unconditionally every boot; a no-op once every slip is already off.
  db.prepare('UPDATE site_billing_slips SET apply_correction_factor=0').run();

  return db;
}

if (require.main === module) { main().close(); }
module.exports = { run: main };
