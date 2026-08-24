// recovery_groups.js - defines City Deep's 3-way tenant grouping for the Recovery ("tenant billing
// vs real municipal statement") comparison page, confirmed directly by the client (image supplied
// 2026-08-08): every tenant compares against exactly one of the site's 4 municipal accounts -
// Industrial A (559304053) & Industrial B (559304060) combined, Rittle (559304085) alone, or Mini
// (559304078) alone. municipal_compare.js's SITE_MAP already encodes this account->group mapping
// (Industrial A/B -> 'Industrial Park', Rittle -> 'City Deep', Mini -> 'Mini Park'), so this file
// only has to say which TENANTS fall in each group.
//
// Deliberately NOT implemented by reassigning tenants.site_id: that column drives a real billing
// calculation branch (billing.js's `tenant.site_name === 'Mini Park'` decides whether the kVArh
// demand-charge formula applies to a tenant's actual bill - see billing.js and seed.js's own
// siteForTenantName()/precinctYEnabled notes), not just a display label. Two tenants' Recovery
// grouping genuinely differs from their billing/precinct site:
//   - Unit 4 ATC SA Wireless Infrastructure (PTY) LTD bills on the "Mini Park" precinct formula
//     (tenants.site_id stays Mini Park - don't touch it) but its municipal account is Industrial.
//   - Shop 2 Growers Connect - Mini Park bills on the "Mini Park" precinct formula too, but is the
//     sole tenant on the separate Rittle municipal account.
// Moving either tenant's site_id to match the image would silently change its real bill (turn the
// Y-charge on/off), which is a genuine billing bug, not a cosmetic fix - so the override lives only
// here, read-only, used solely to build the Recovery comparison rows.
// Renamed 2026-08-24 (was 'Unit 4 ATC SA Wireless Infrastructure (PTY) LTD') - keep in sync with
// city-deep/seed.js's TENANT_DISPLAY_OVERRIDES, since this array matches by exact tenant.name.
const EXTRA_INDUSTRIAL_TENANTS = ['ATC SA Wireless Infrastructure (Pty) Ltd'];
const RITTLE_TENANTS = ['Shop 2 Growers Connect - Mini Park'];

// `siteNameForMunicipal` must match municipal_compare.js's SITE_MAP values exactly so
// tenant_recovery.js's municipalSideFor() resolves the right account(s) automatically.
const SECTIONS = [
  { key: 'industrial', title: 'Industrial Park (Industrial A & B accounts)', siteNameForMunicipal: 'Industrial Park' },
  { key: 'rittle', title: 'City Deep (Rittle account)', siteNameForMunicipal: 'City Deep' },
  { key: 'mini', title: 'Mini Park (Mini account)', siteNameForMunicipal: 'Mini Park' },
];

// The tenant NAMES (not ids - matches tenant_recovery.js's siteSideForTenants, which filters
// bills by t.name IN (...)) that belong in Recovery section `key`. Any tenant not explicitly
// special-cased above falls back to its real tenants.site_id/sites.name grouping, so new tenants
// added later to Industrial Park or Mini Park show up in the right section automatically without
// this file needing an update - only the two special cases above need to be listed by hand.
function tenantNamesForSection(db, key) {
  const rows = db.prepare(`SELECT t.name AS name, s.name AS site_name FROM tenants t JOIN sites s ON s.id = t.site_id`).all();
  if (key === 'industrial') {
    return rows.filter((r) => r.site_name === 'Industrial Park' || EXTRA_INDUSTRIAL_TENANTS.includes(r.name)).map((r) => r.name);
  }
  if (key === 'rittle') {
    return RITTLE_TENANTS;
  }
  if (key === 'mini') {
    return rows.filter((r) => r.site_name === 'Mini Park' && !EXTRA_INDUSTRIAL_TENANTS.includes(r.name) && !RITTLE_TENANTS.includes(r.name)).map((r) => r.name);
  }
  return [];
}

module.exports = { SECTIONS, tenantNamesForSection, EXTRA_INDUSTRIAL_TENANTS, RITTLE_TENANTS };
