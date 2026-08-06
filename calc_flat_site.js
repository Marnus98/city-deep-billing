// calc_flat_site.js - the generalized "flat single-site" billing calculation, shared by every
// flat_site property (properties.js's billingModel: 'flat_site') regardless of which tariff shape
// it's on. Replaces the old field-street/calc_field_street.js, which hardcoded one specific shape
// (Ekurhuleni Tariff E TOU) - once a second site turned up on a genuinely different tariff (own
// line items, own order, own names - see flat_site_tariff_shapes.js), the calculation itself had to
// stop assuming a fixed set of rows and instead just walk whatever line items the site's current
// tariff version defines.
//
// A flat_site property still bills the whole site as one fixed set of line items every month (no
// per-tenant meter allocation) - what varies per site is *which* line items and in what order,
// which now lives in the site_tariff_items table (see db.js) instead of being baked into this file.
function round2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

const VAT_RATE = 0.15;

// `tariffItems` - array of site_tariff_items rows (already ordered by sort_order) for the slip's
// tariff version. `readingsByKey` - map of item_key -> { reading, comment } from
// site_slip_readings for this slip. `tariff` - the site_tariffs row (holds the 4 correction
// factors). `applyCorrectionFactor` - the slip's own on/off switch (0/1) for those factors.
//
// Returns { elecItems, waterItems, elecTotal, waterTotal, subtotal, vatRate, vatAmount, total } -
// same shape the views/pdf layers already expect from the old calc_field_street.js, so
// views.js/pdf.js don't need to know a generic engine is behind it.
function computeSlip(tariffItems, readingsByKey, tariff, applyCorrectionFactor) {
  const applyFactor = !(applyCorrectionFactor === 0 || applyCorrectionFactor === false);
  const items = tariffItems.map((it) => {
    const r = readingsByKey[it.item_key];
    const reading = it.fixed_reading != null ? it.fixed_reading : Number((r && r.reading) || 0);
    const rate = Number(it.rate || 0);
    const factorCol = it.factor_type ? `${it.factor_type}_factor` : null;
    const factor = (applyFactor && factorCol) ? Number(tariff[factorCol] || 1) : 1;
    const adjustedReading = reading * factor;
    const cost = round2(adjustedReading * rate);
    return {
      key: it.item_key, label: it.label, unit: it.unit, rate, reading, factor, adjustedReading, cost,
      comment: it.has_comment ? ((r && r.comment) || null) : null, section: it.section, factor_type: it.factor_type,
      vatExempt: !!it.vat_exempt,
    };
  });
  // 'municipal' is a third bucket only municipal account statements use (Property Rates, Refuse -
  // see municipal_seed_helpers.js/db.js) - every existing flat_site property's items are always
  // 'electricity' or 'water', so municipalItems is always [] for them and this is a no-op there.
  const elecItems = items.filter((i) => i.section !== 'water' && i.section !== 'municipal');
  const waterItems = items.filter((i) => i.section === 'water');
  const municipalItems = items.filter((i) => i.section === 'municipal');
  const elecTotal = round2(elecItems.reduce((s, i) => s + i.cost, 0));
  const waterTotal = round2(waterItems.reduce((s, i) => s + i.cost, 0));
  const municipalTotal = round2(municipalItems.reduce((s, i) => s + i.cost, 0));
  const subtotal = round2(elecTotal + waterTotal + municipalTotal);
  // Property Rates is VAT-exempt on the real municipal statement (see db.js's vat_exempt column) -
  // everything else in every flat_site shape has vatExempt false/undefined, so this is a no-op for
  // the client-facing site billing slips and every non-municipal item on the municipal one too.
  const vatableBase = round2(items.reduce((s, i) => s + (i.vatExempt ? 0 : i.cost), 0));
  const vatAmount = round2(vatableBase * VAT_RATE);
  const total = round2(subtotal + vatAmount);
  return { elecItems, waterItems, municipalItems, elecTotal, waterTotal, municipalTotal, subtotal, vatRate: VAT_RATE, vatAmount, total };
}

module.exports = { computeSlip, round2 };
