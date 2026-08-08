// tenant_recovery.js - "tenant billing vs the real municipal statement" comparison for tenant-model
// properties (currently just Wingfield Business Park - see properties.js's recoverySiteName field).
// Mirrors flat_site_recovery.js's Electricity/Water/Sewer Recovery page/PDF exactly - same row shape
// ({label, site, municipal, recovery, totalSiteRand, totalMunicipalRand, totalRecoveryRand}, same
// per-utility {elecRand, elecKwh, waterRand, waterKl, sewerRand, sewerKl} shape on each side) - so
// views.js's recoveryPage() and pdf.js's buildRecoveryPdf() render this property's data completely
// unchanged. Only HOW each side's figures get produced differs from the flat_site version.
//
// Matching can't be done by label here, unlike flat_site: Wingfield's own billing_periods table
// labels each tenant billing period by the month it's INVOICED in (a pre-existing, already-in-
// production convention, predating this app entirely and untouched by the 2026-08-07 municipal-
// statement relabelling fix - see seed_wingfield_municipal.js's own note on this), while municipal
// statements are now labelled by the month their consumption actually happened in. So the exact same
// real-world date window can carry two different labels on each side - e.g. the window spanning
// 2026-06-01 to 2026-07-01 is tenant billing_period '2026-07' but municipal statement '2026-06'.
// Instead, this reuses municipal_compare.js's own proven method: match a billing_period's own
// [start_date, end_date] against whichever municipal statement(s) (there can be more than one
// account mapped to a site, see SITE_MAP) has the greatest date overlap with it - not label
// equality. Each resulting row's own `label` is still the tenant billing_period's label (that's the
// calendar the page is organised around), with whichever municipal data best overlaps it alongside.
//
// Both sides are compared EXCL VAT here - unlike municipal_compare.js's existing "Our billing vs
// utility" section on the Municipal Account page (which mixes tenant excl-VAT charges against
// municipal incl-VAT ones), this uses the same excl-VAT-both-sides convention flat_site_recovery.js
// already established, so the two totals here are genuinely apples-to-apples.
const municipalCompare = require('./municipal_compare');

function get(db, sql, params = []) { return db.prepare(sql).get(...params); }
function all(db, sql, params = []) { return db.prepare(sql).all(...params); }

// This app's own tenant billing for `siteName`, split Electricity / Water / Sewer (sanitation),
// excl VAT, summed across every tenant for one billing period. null if no tenant was billed at all
// that period (distinct from "billed R0", same convention flat_site_recovery.js uses). Two separate
// queries rather than one JOIN across bills and bill_line_items - bills:bill_line_items is 1:many,
// so summing bills.electricity_consumption_kwh in the same row set as the line-item join would fan
// out and multiply it by however many line items each bill has (the exact bug municipal_compare.js's
// own ourSiteTotals already had to avoid - see its comment).
//
// water/sewer category lists (see calc.js's calcWaterMeterLine + billing.js's own water_levy push):
// a tenant's water bill can carry water_charge/water_surcharge/water_levy (water+common-area levy)
// and sanitation/sanitation_surcharge (sewer) as up to 5 separate bill_line_items rows - matching
// only 'water_charge'/'sanitation_charge' (the original, narrower filter here) silently dropped the
// surcharge and levy rows from water, and matched NOTHING for sewer at all since City Deep's own
// data uses category 'sanitation', not 'sanitation_charge' (confirmed: R0 sewer on every City Deep
// Recovery row despite real sanitation charges on the tenant's own bill). 'sanitation_charge' is
// still included here too - Wingfield's older bill data uses that exact category name instead of
// 'sanitation' and has no separate surcharge/levy rows at all, so both conventions need to be
// covered for the two properties' data to compare correctly.
function siteSideFor(db, siteName, periodId) {
  const consumption = get(db, `
    SELECT COALESCE(SUM(b.electricity_consumption_kwh),0) AS elec_kwh,
      COALESCE(SUM(b.water_consumption_m3),0) AS water_kl,
      COUNT(DISTINCT b.tenant_id) AS tenant_count
    FROM bills b
    JOIN tenants t ON t.id = b.tenant_id
    JOIN sites s ON s.id = t.site_id
    WHERE s.name = ? AND b.billing_period_id = ?
  `, [siteName, periodId]);
  if (!consumption.tenant_count) return null;
  const period = get(db, 'SELECT start_date, end_date FROM billing_periods WHERE id=?', [periodId]);
  const charges = get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN bli.utility_type='electricity' THEN bli.amount END), 0) AS elec_rand,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category IN ('water_charge','water_surcharge','water_levy') THEN bli.amount END), 0) AS water_rand,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category IN ('sanitation','sanitation_charge','sanitation_surcharge') THEN bli.amount END), 0) AS sewer_rand
    FROM bill_line_items bli
    JOIN bills b ON b.id = bli.bill_id
    JOIN tenants t ON t.id = b.tenant_id
    JOIN sites s ON s.id = t.site_id
    WHERE s.name = ? AND b.billing_period_id = ?
  `, [siteName, periodId]);
  return {
    elecRand: charges.elec_rand, elecKwh: consumption.elec_kwh,
    waterRand: charges.water_rand, sewerRand: charges.sewer_rand,
    // Sanitation is billed on the same water reading, not its own separate meter (same convention
    // every municipal statement in this app already uses - see e.g. flat_site_tariff_shapes.js's
    // WATER_SEWER_ITEMS comment) - so sewerKl reuses waterKl rather than being tracked separately.
    waterKl: consumption.water_kl, sewerKl: consumption.water_kl,
    // The billing_period's own dates (shared across every tenant in it, unlike a flat_site slip which
    // has its own unique dates) - carried through so the Recovery page/PDF can flag a long period the
    // same way the Municipal Account pages do (see municipal_compare.js's LONG_PERIOD_DAYS).
    startDate: period && period.start_date, endDate: period && period.end_date,
  };
}

// Same as siteSideFor above, but filters by an explicit list of tenant NAMES instead of matching
// tenants.site_id via `sites.name = siteName`. Needed for City Deep's Recovery grouping, which is
// coarser than (and in two cases diverges from) the site_id-based precinct grouping billing.js uses
// for real bill calculation - see city-deep/recovery_groups.js's header comment for exactly why.
// `tenantNames` is expected non-empty; an empty array would build a `NOT IN ()`-shaped broken SQL
// list, so callers (see city-deep/recovery_groups.js) should never pass one for a real section.
function siteSideForTenants(db, tenantNames, periodId) {
  const placeholders = tenantNames.map(() => '?').join(',');
  const consumption = get(db, `
    SELECT COALESCE(SUM(b.electricity_consumption_kwh),0) AS elec_kwh,
      COALESCE(SUM(b.water_consumption_m3),0) AS water_kl,
      COUNT(DISTINCT b.tenant_id) AS tenant_count
    FROM bills b
    JOIN tenants t ON t.id = b.tenant_id
    WHERE t.name IN (${placeholders}) AND b.billing_period_id = ?
  `, [...tenantNames, periodId]);
  if (!consumption.tenant_count) return null;
  const period = get(db, 'SELECT start_date, end_date FROM billing_periods WHERE id=?', [periodId]);
  const charges = get(db, `
    SELECT
      COALESCE(SUM(CASE WHEN bli.utility_type='electricity' THEN bli.amount END), 0) AS elec_rand,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category IN ('water_charge','water_surcharge','water_levy') THEN bli.amount END), 0) AS water_rand,
      COALESCE(SUM(CASE WHEN bli.utility_type='water' AND bli.category IN ('sanitation','sanitation_charge','sanitation_surcharge') THEN bli.amount END), 0) AS sewer_rand
    FROM bill_line_items bli
    JOIN bills b ON b.id = bli.bill_id
    JOIN tenants t ON t.id = b.tenant_id
    WHERE t.name IN (${placeholders}) AND b.billing_period_id = ?
  `, [...tenantNames, periodId]);
  return {
    elecRand: charges.elec_rand, elecKwh: consumption.elec_kwh,
    waterRand: charges.water_rand, sewerRand: charges.sewer_rand,
    waterKl: consumption.water_kl, sewerKl: consumption.water_kl,
    startDate: period && period.start_date, endDate: period && period.end_date,
  };
}

// The real municipal statement(s) covering `siteName` for the date window [periodStart, periodEnd] -
// summed across every municipal account mapped to this site (see municipal_compare.js's SITE_MAP;
// Wingfield only has the one, 'Refinery', but this stays generic for any future tenant-model site
// with more than one bulk account). null if nothing overlaps at all (e.g. a month with no statement
// uploaded yet).
function municipalSideFor(db, siteName, periodStart, periodEnd) {
  const accountLabels = Object.keys(municipalCompare.SITE_MAP).filter((l) => municipalCompare.SITE_MAP[l] === siteName);
  if (!accountLabels.length) return null;
  const accounts = all(db, `SELECT * FROM municipal_accounts WHERE label IN (${accountLabels.map(() => '?').join(',')})`, accountLabels);
  let elecKwh = 0, elecRand = 0, waterKl = 0, waterRand = 0, sewerRand = 0, sewerKl = 0, matched = false;
  // Widest span across every matched statement (usually just one, since Wingfield's SITE_MAP has a
  // single account - see file header note - but kept generic) - used the same way flat_site_recovery
  // carries a slip's own start/end through, so a long/combined municipal statement gets flagged here
  // too (see municipal_compare.js's LONG_PERIOD_DAYS).
  let minStart = null, maxEnd = null;
  // Water's own reading period, tracked separately from electricity's - municipal_statements has
  // always had its own water_reading_start/water_reading_end columns (see db.js and
  // seed_municipal.js), the municipality reads water on a genuinely different cycle from
  // electricity almost every month (confirmed here the same way it was confirmed for every
  // flat_site property - e.g. Rittle's Oct 2025 statement: elec 2025/08/30-2025/09/28 vs water
  // 2025/08/08-2025/09/25) - this just hadn't been surfaced out of this function yet. Falls back to
  // the electricity dates if a statement genuinely has no water reading dates of its own (nullable
  // column - an INTERIM/estimated month, same convention as every municipal_import.js).
  let minWaterStart = null, maxWaterEnd = null;
  for (const acc of accounts) {
    const statements = all(db, 'SELECT * FROM municipal_statements WHERE municipal_account_id=?', [acc.id]);
    let best = null, bestDays = 0;
    for (const s of statements) {
      const sStart = s.elec_reading_start || s.water_reading_start;
      const sEnd = s.elec_reading_end || s.water_reading_end;
      // Gate on the statement's own midpoint falling inside this billing period, not just "any
      // overlap at all" - see municipal_compare.js's rangeMidpointWithin for exactly why (a
      // statement can show a few days of edge overlap with an ADJACENT period purely from month-
      // boundary mismatch without genuinely belonging there - this was letting the same statement
      // match two different billing periods at once and hiding a genuine "no statement yet" gap).
      if (!municipalCompare.rangeMidpointWithin(sStart, sEnd, periodStart, periodEnd)) continue;
      const d = municipalCompare.daysOverlap(periodStart, periodEnd, sStart, sEnd);
      if (d > bestDays) { bestDays = d; best = s; }
    }
    if (best && bestDays > 0) {
      matched = true;
      elecKwh += best.elec_consumption_kwh || 0; elecRand += best.elec_excl_vat || 0;
      waterKl += best.water_consumption_kl || 0; waterRand += best.water_excl_vat || 0;
      sewerRand += best.sanitation_excl_vat || 0; sewerKl += best.water_consumption_kl || 0;
      const bStart = best.elec_reading_start || best.water_reading_start;
      const bEnd = best.elec_reading_end || best.water_reading_end;
      if (bStart && (!minStart || bStart < minStart)) minStart = bStart;
      if (bEnd && (!maxEnd || bEnd > maxEnd)) maxEnd = bEnd;
      const wStart = best.water_reading_start || bStart;
      const wEnd = best.water_reading_end || bEnd;
      if (wStart && (!minWaterStart || wStart < minWaterStart)) minWaterStart = wStart;
      if (wEnd && (!maxWaterEnd || wEnd > maxWaterEnd)) maxWaterEnd = wEnd;
    }
  }
  if (!matched) return null;
  return {
    elecRand, elecKwh, waterRand, waterKl, sewerRand, sewerKl,
    startDate: minStart, endDate: maxEnd,
    waterStartDate: minWaterStart, waterEndDate: maxWaterEnd,
  };
}

// Full comparison for `siteName`: one row per billing_period (trailing `limit`, default 12,
// chronological ascending), each with whichever municipal data best date-overlaps it. A period
// missing one side still gets a row with that side null and no `recovery` object - same "flag a
// genuine gap rather than hide it" convention flat_site_recovery.js uses.
function buildRecoveryRows(db, siteName, { limit = 12 } = {}) {
  const periods = all(db, 'SELECT * FROM billing_periods ORDER BY start_date').slice(-limit);
  return periods.map((p) => {
    const site = siteSideFor(db, siteName, p.id);
    const municipal = municipalSideFor(db, siteName, p.start_date, p.end_date);
    const row = { label: p.label, site, municipal, recovery: null };
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

// Same as buildRecoveryRows above, but the site (tenant billing) side is filtered by an explicit
// tenant-name list (siteSideForTenants) instead of a single sites.name match - the municipal side
// still resolves via `siteNameForMunicipal` against SITE_MAP exactly as before. See
// city-deep/recovery_groups.js for why City Deep needs this instead of plain buildRecoveryRows.
function buildRecoveryRowsForTenants(db, siteNameForMunicipal, tenantNames, { limit = 12 } = {}) {
  const periods = all(db, 'SELECT * FROM billing_periods ORDER BY start_date').slice(-limit);
  return periods.map((p) => {
    const site = tenantNames.length ? siteSideForTenants(db, tenantNames, p.id) : null;
    const municipal = municipalSideFor(db, siteNameForMunicipal, p.start_date, p.end_date);
    const row = { label: p.label, site, municipal, recovery: null };
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

module.exports = { buildRecoveryRows, buildRecoveryRowsForTenants, siteSideFor, siteSideForTenants, municipalSideFor };
