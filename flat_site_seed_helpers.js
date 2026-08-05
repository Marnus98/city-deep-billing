// flat_site_seed_helpers.js - shared idempotent insert helpers for every flat_site property's
// seed/import script (field-street/seed.js, field-street/import_history.js, and the equivalent
// scripts for Bob Martin, Loper Road - Sandvic, AutoZone, Cranbrook Flavours). Written once here so
// every site's seed script is just "here's my shape + my rates + my monthly readings", not another
// copy of the same INSERT/dedup logic.
function run(db, sql, params = []) { return db.prepare(sql).run(...params); }
function get(db, sql, params = []) { return db.prepare(sql).get(...params); }

// Idempotent by (tariff_name, effective_from) - safe to call on every boot. `shape` is one of the
// arrays exported by flat_site_tariff_shapes.js; `rates` maps item key -> rate; `factors` is
// { kva_factor, peak_factor, standard_factor, offpeak_factor }. Returns the tariff's id.
function seedTariff(db, { tariffName, effectiveFrom, shape, rates, factors, notes }) {
  const existing = get(db, 'SELECT id FROM site_tariffs WHERE tariff_name=? AND effective_from=?', [tariffName, effectiveFrom]);
  if (existing) return existing.id;
  run(db, `INSERT INTO site_tariffs (tariff_name, effective_from, kva_factor, peak_factor, standard_factor, offpeak_factor, notes)
    VALUES (?,?,?,?,?,?,?)`,
    [tariffName, effectiveFrom, factors.kva_factor, factors.peak_factor, factors.standard_factor, factors.offpeak_factor, notes || null]);
  const tariffId = get(db, 'SELECT id FROM site_tariffs ORDER BY id DESC LIMIT 1').id;
  shape.forEach((it, i) => {
    run(db, `INSERT INTO site_tariff_items (tariff_id, sort_order, section, item_key, label, unit, rate, factor_type, fixed_reading, has_comment)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [tariffId, i, it.section, it.key, it.label, it.unit, Number(rates[it.key]) || 0, it.factorType, it.fixedReading, it.hasComment ? 1 : 0]);
  });
  return tariffId;
}

// Idempotent by label (site_billing_slips.label is UNIQUE) - safe to call on every boot; skips
// (doesn't touch) a slip that already exists, so it never clobbers a reading the client has since
// edited by hand. `readings` maps item key -> reading number, or { reading, comment } for rows
// that carry a comment (network access/demand style max-demand timestamps).
function seedSlip(db, tariffId, { label, startDate, endDate, readings, applyCorrectionFactor = 1, status = 'finalised' }) {
  if (get(db, 'SELECT id FROM site_billing_slips WHERE label=?', [label])) return null;
  run(db, `INSERT INTO site_billing_slips (label, start_date, end_date, tariff_id, apply_correction_factor, status)
    VALUES (?,?,?,?,?,?)`, [label, startDate, endDate, tariffId, applyCorrectionFactor, status]);
  const slipId = get(db, 'SELECT id FROM site_billing_slips WHERE label=?', [label]).id;
  for (const [key, val] of Object.entries(readings || {})) {
    const reading = (val != null && typeof val === 'object') ? val.reading : val;
    const comment = (val != null && typeof val === 'object') ? (val.comment || null) : null;
    run(db, 'INSERT INTO site_slip_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,?)', [slipId, key, reading, comment]);
  }
  return slipId;
}

module.exports = { seedTariff, seedSlip };
