// municipal_seed_helpers.js - shared idempotent insert helpers for a flat_site property's
// municipal account statement import script (field-street/municipal_import.js, and the equivalent
// for any future site). Mirrors flat_site_seed_helpers.js exactly, just targeting the parallel
// municipal_tariffs/municipal_tariff_items/municipal_statement_slips/municipal_statement_readings
// tables (see db.js for why these are a separate set of tables rather than the same ones).
function run(db, sql, params = []) { return db.prepare(sql).run(...params); }
function get(db, sql, params = []) { return db.prepare(sql).get(...params); }

// Idempotent by (tariff_name, effective_from) - safe to call on every boot. Returns the tariff's id.
function seedMunicipalTariff(db, { tariffName, effectiveFrom, shape, rates, factors, notes }) {
  const existing = get(db, 'SELECT id FROM municipal_tariffs WHERE tariff_name=? AND effective_from=?', [tariffName, effectiveFrom]);
  if (existing) return existing.id;
  const f = factors || { kva_factor: 1, peak_factor: 1, standard_factor: 1, offpeak_factor: 1 };
  run(db, `INSERT INTO municipal_tariffs (tariff_name, effective_from, kva_factor, peak_factor, standard_factor, offpeak_factor, notes)
    VALUES (?,?,?,?,?,?,?)`,
    [tariffName, effectiveFrom, f.kva_factor, f.peak_factor, f.standard_factor, f.offpeak_factor, notes || null]);
  const tariffId = get(db, 'SELECT id FROM municipal_tariffs ORDER BY id DESC LIMIT 1').id;
  shape.forEach((it, i) => {
    run(db, `INSERT INTO municipal_tariff_items (tariff_id, sort_order, section, item_key, label, unit, rate, factor_type, fixed_reading, has_comment, vat_exempt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [tariffId, i, it.section, it.key, it.label, it.unit, Number(rates[it.key]) || 0, it.factorType, it.fixedReading, it.hasComment ? 1 : 0, it.vatExempt ? 1 : 0]);
  });
  return tariffId;
}

// Idempotent by label - safe to call on every boot; skips a statement that already exists so it
// never clobbers a figure the client has since corrected by hand.
function seedMunicipalStatement(db, tariffId, { label, startDate, endDate, readings, applyCorrectionFactor = 0, status = 'finalised' }) {
  if (get(db, 'SELECT id FROM municipal_statement_slips WHERE label=?', [label])) return null;
  run(db, `INSERT INTO municipal_statement_slips (label, start_date, end_date, tariff_id, apply_correction_factor, status)
    VALUES (?,?,?,?,?,?)`, [label, startDate, endDate, tariffId, applyCorrectionFactor, status]);
  const slipId = get(db, 'SELECT id FROM municipal_statement_slips WHERE label=?', [label]).id;
  for (const [key, val] of Object.entries(readings || {})) {
    const reading = (val != null && typeof val === 'object') ? val.reading : val;
    const comment = (val != null && typeof val === 'object') ? (val.comment || null) : null;
    run(db, 'INSERT INTO municipal_statement_readings (slip_id, item_key, reading, comment) VALUES (?,?,?,?)', [slipId, key, reading, comment]);
  }
  return slipId;
}

module.exports = { seedMunicipalTariff, seedMunicipalStatement };
