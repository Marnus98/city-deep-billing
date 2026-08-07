// flat_site_recovery.js - "tenant billing vs the real municipal bill" comparison for flat_site
// properties that have both site_billing_slips (what HolmStone bills the client) and
// municipal_statement_slips (what the municipality actually charges) - currently 8 Field Street,
// Bob Martin and AutoZone (see properties.js's hasMunicipalStatements flag). Loper Road and
// Cranbrook Flavours have no municipal statements imported yet, so this module is simply never
// invoked for them (their nav has no link to the page that calls it - see views.js).
//
// Matching is by `label` - both tables use the same 'YYYY-MM' string for the same calendar month
// throughout this app (every property's import_history.js/municipal_import.js keeps them aligned
// deliberately) - much simpler than municipal_compare.js's date-overlap matching for the tenant-
// billing model, since flat_site properties don't have the "several sub-accounts, different
// statement cadence" problem city-deep/wingfield do.
//
// "Recovery" here means: of what the municipality actually charges for electricity/water/sewer,
// how much is HolmStone recovering by billing the client? Positive = billed the client MORE than
// the municipality charged (over-recovery); negative = billed LESS (under-recovery, an absorbed
// loss). Property Rates, Refuse and Sundry are deliberately excluded from every figure here - real
// municipal-only costs, but never meant to flow through to the client (see e.g. field-street/
// municipal_import.js's Property Rates notes) - including them would always show a large
// "under-recovery" that isn't actually about utility billing accuracy at all. calc_flat_site.js's
// own elecItems/waterItems/municipalItems split already keeps these apart, so this module just
// reads elecItems + the water/sewer entries from waterItems on both sides.
const calcFlatSite = require('./calc_flat_site');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

// Same convention as server.js's own sumElecKwh (see monthlyTrendForSite/monthlyTrendForMunicipal)
// - works unmodified against either a site tariff's items or a municipal tariff's items, since
// every shape in flat_site_tariff_shapes.js uses these same peak_/standard_/offpeak_ key prefixes.
function sumElecKwh(elecItems) {
  return elecItems.filter((i) => i.key.startsWith('peak_') || i.key.startsWith('standard_') || i.key.startsWith('offpeak_'))
    .reduce((s, i) => s + i.adjustedReading, 0);
}

function figuresFromCalc(calc, slip) {
  const waterItem = calc.waterItems.find((i) => i.key === 'water');
  const sewerItem = calc.waterItems.find((i) => i.key === 'sewer');
  return {
    elecRand: calc.elecTotal, elecKwh: sumElecKwh(calc.elecItems),
    waterRand: waterItem ? waterItem.cost : 0, waterKl: waterItem ? waterItem.reading : 0,
    sewerRand: sewerItem ? sewerItem.cost : 0, sewerKl: sewerItem ? sewerItem.reading : 0,
    // The slip's own exact reading-period dates (not just the 'YYYY-MM' label) - carried through so
    // the Recovery page/PDF can show and flag the *real* billing period, same "management meeting
    // accuracy" ask this was added for on the Municipal Account pages themselves (see
    // municipal_compare.js's LONG_PERIOD_DAYS / views.js's periodBadge).
    startDate: slip.start_date, endDate: slip.end_date,
  };
}

// One side's figures for one label, or null if that side has no slip under this label at all
// (e.g. a municipal statement was never uploaded for that month - see every property's own
// "missing months" notes).
function siteSideFor(db, label) {
  const slip = get(db, 'SELECT * FROM site_billing_slips WHERE label=?', [label]);
  if (!slip) return null;
  const tariff = get(db, 'SELECT * FROM site_tariffs WHERE id=?', [slip.tariff_id]);
  const items = all(db, 'SELECT * FROM site_tariff_items WHERE tariff_id=? ORDER BY sort_order', [slip.tariff_id]);
  const readingRows = all(db, 'SELECT * FROM site_slip_readings WHERE slip_id=?', [slip.id]);
  const readings = {}; for (const r of readingRows) readings[r.item_key] = { reading: r.reading, comment: r.comment };
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  return figuresFromCalc(calc, slip);
}

function municipalSideFor(db, label) {
  const slip = get(db, 'SELECT * FROM municipal_statement_slips WHERE label=?', [label]);
  if (!slip) return null;
  const tariff = get(db, 'SELECT * FROM municipal_tariffs WHERE id=?', [slip.tariff_id]);
  const items = all(db, 'SELECT * FROM municipal_tariff_items WHERE tariff_id=? ORDER BY sort_order', [slip.tariff_id]);
  const readingRows = all(db, 'SELECT * FROM municipal_statement_readings WHERE slip_id=?', [slip.id]);
  const readings = {}; for (const r of readingRows) readings[r.item_key] = { reading: r.reading, comment: r.comment };
  const calc = calcFlatSite.computeSlip(items, readings, tariff, slip.apply_correction_factor);
  return figuresFromCalc(calc, slip);
}

// Every label present in either table, chronological ascending.
function allLabels(db) {
  const a = all(db, 'SELECT DISTINCT label FROM site_billing_slips').map((r) => r.label);
  const b = all(db, 'SELECT DISTINCT label FROM municipal_statement_slips').map((r) => r.label);
  return [...new Set([...a, ...b])].sort();
}

// Full comparison: one row per label with either side present, trailing `limit` months (default
// 12, matching every other trend view in this app), chronological ascending (callers wanting
// newest-first for a table just reverse a copy - see views.js's recoveryPage). A label missing one
// side (site or municipal) still gets a row, with that side null and no `recovery` object - the
// view renders those as "no data" rather than silently dropping the month, since a genuinely
// missing municipal statement is itself worth flagging, not hiding.
function buildRecoveryRows(db, { limit = 12 } = {}) {
  const labels = allLabels(db).slice(-limit);
  return labels.map((label) => {
    const site = siteSideFor(db, label);
    const municipal = municipalSideFor(db, label);
    const row = { label, site, municipal, recovery: null };
    if (site && municipal) {
      row.recovery = {
        elecRand: site.elecRand - municipal.elecRand, elecKwh: site.elecKwh - municipal.elecKwh,
        waterRand: site.waterRand - municipal.waterRand, waterKl: site.waterKl - municipal.waterKl,
        sewerRand: site.sewerRand - municipal.sewerRand, sewerKl: site.sewerKl - municipal.sewerKl,
      };
      row.totalSiteRand = site.elecRand + site.waterRand + site.sewerRand;
      row.totalMunicipalRand = municipal.elecRand + municipal.waterRand + municipal.sewerRand;
      row.totalRecoveryRand = row.totalSiteRand - row.totalMunicipalRand;
    }
    return row;
  });
}

module.exports = { buildRecoveryRows, siteSideFor, municipalSideFor, allLabels };
