// properties.js - registry of the physical properties this platform manages. Each property gets
// its own completely separate SQLite database file (see db.js's open(fileName)) so there is no
// shared table for a missed WHERE clause to leak one property's tenants/bills/tariffs into
// another's - the isolation is physical (different file), not a query-level filter.
//
// The one thing NOT listed here is logins: `users` lives in its own shared data/auth.db (see
// server.js) so one set of credentials works across every property in this list.
//
// To add a new property: add an entry here (dbFile should be unique), then build a folder the
// same way city-deep/, wingfield/ and field-street/ were built - its own seed_<slug>.js (copy the
// pattern from wingfield/seed_wingfield.js for a tenant-billed property, or field-street/seed.js
// for a flat single-site one), its own imports/ subfolder for extracted workbook JSON if it has
// one, and set seedFile below to require() it.
//
// Each property's own code+data lives in its own top-level folder (city-deep/, wingfield/,
// field-street/) so they don't get interleaved in one flat directory listing - only genuinely
// shared platform code (server.js, views.js, db.js, billing.js, calc.js, etc.) lives at the root.
//
// `billingModel` controls which parts of the app apply to this property (see views.js's layout()
// nav and server.js's route guards):
//   'tenant'    - the City Deep/Wingfield model: many tenants, each with their own assigned
//                 meters, billed monthly via Tenants/Meters/Billing Periods/Billing/Solar.
//   'flat_site' - the 8 Field Street model: the whole property is one billing unit with a fixed
//                 set of tariff line items every month (see db.js's site_tariffs/
//                 site_billing_slips) - no per-tenant meter allocation at all.
module.exports = [
  {
    slug: 'city-deep',
    name: 'City Deep Industrial Park',
    dbFile: 'city-deep.db',
    seedFile: './city-deep/seed',
    billingModel: 'tenant',
    // City Deep's own municipal data spans 4 accounts across 3 real precincts (Industrial A+B,
    // Rittle, Mini - see municipal_compare.js's SITE_MAP), and its Recovery comparison is grouped
    // into those same 3 sections rather than one property-wide total - see
    // city-deep/recovery_groups.js for the tenant grouping (confirmed by the client 2026-08-08) and
    // tenant_recovery.js's buildRecoveryRowsForTenants for how each section's rows are built.
    // Distinct from recoverySiteName (Wingfield's single-section flag) - server.js checks this one
    // first.
    recoveryMultiSection: true,
    // "Flagging" tab (see flagging.js + city-deep/flagging_data.js) - internal exception-reporting
    // tool for RPI, separate from tenant billing entirely. Piloted here first (confirmed with the
    // client 2026-08-24), then rolled out to every property (2026-08-25) once approved - see
    // wingfield/flagging_data.js and flat_site_flagging_data.js for the other two billingModels'
    // own data layers, and server.js's currentPropFlagRows for how the right one gets picked.
    hasFlagging: true,
    // Chart-based Flagging layout (see views.js's chartSection/trendChartCard, pdf.js's
    // drawFlagChartCard) - monthly consumption bars with a shaded average/amber/red band, a real
    // Y-axis, and a short description, instead of the dense flagDetailRows table. Piloted on
    // AutoZone only, then rolled out to every property including all of a tenant-model property's
    // own flagged tenants (2026-08-25, confirmed by the client).
    flaggingChartLayout: true,
  },
  {
    slug: 'wingfield',
    name: 'Wingfield Business Park',
    dbFile: 'wingfield.db',
    seedFile: './wingfield/seed_wingfield', // added once a Wingfield workbook is imported - see README
    billingModel: 'tenant',
    // Enables the "Recovery" nav tab for this tenant-model property (see tenant_recovery.js and
    // municipal_compare.js's SITE_MAP) - the value is the site name tenant_recovery.js compares
    // against, matching SITE_MAP's own 'Refinery' -> 'Wingfield Business Park' mapping. City Deep
    // isn't set up with this yet (its own municipal data spans 4 accounts across 3 sites, more setup
    // than a single flag - can follow the same pattern once wanted).
    recoverySiteName: 'Wingfield Business Park',
    // See wingfield/flagging_data.js - single municipal account + whole-site "section" + every
    // tenant, same rollout as City Deep (2026-08-25).
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'field-street',
    name: '8 Field Street',
    dbFile: 'field-street.db',
    seedFile: './field-street/seed',
    billingModel: 'flat_site',
    // Has a real municipal_import.js (see field-street/municipal_import.js) alongside its own
    // client billing - so the "Recovery" nav tab (tenant billing vs the real municipal bill, see
    // flat_site_recovery.js) applies here.
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'bob-martin',
    name: 'Bob Martin',
    dbFile: 'bob-martin.db',
    seedFile: './bob-martin/import_history',
    billingModel: 'flat_site',
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'loper-road',
    name: 'Loper Road - Sandvic',
    dbFile: 'loper-road.db',
    seedFile: './loper-road/import_history',
    billingModel: 'flat_site',
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'autozone',
    name: 'AutoZone',
    dbFile: 'autozone.db',
    seedFile: './autozone/import_history',
    billingModel: 'flat_site',
    hasMunicipalStatements: true,
    hasFlagging: true,
    // Chart-based Flagging layout (see views.js's chartSection/trendChartCard) - piloted here first
    // (client feedback 2026-08-25 that the old flagDetailRows table was hard to scan), then rolled
    // out to every property once approved - see the other properties below for the same flag.
    flaggingChartLayout: true,
  },
  {
    slug: 'cranbrook-flavours',
    name: 'Cranbrook Flavours',
    dbFile: 'cranbrook-flavours.db',
    seedFile: './cranbrook-flavours/import_history',
    billingModel: 'flat_site',
    // Has a real municipal_import.js (see cranbrook-flavours/municipal_import.js) alongside its own
    // client billing - so the "Recovery" nav tab (tenant billing vs the real municipal bill, see
    // flat_site_recovery.js) applies here too.
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'adh-machine-tool',
    // Full tenant name, as it appears on the client's own workbook - confirmed with the client
    // 2026-08-20 that the full name should be shown, not a shortened "ADH Machine Tool".
    name: '55 Loper Ave - ADH Machine Tool South Africa (PTY) Ltd',
    dbFile: 'adh-machine-tool.db',
    seedFile: './adh-machine-tool/import_history',
    billingModel: 'flat_site',
    // No municipal_import.js yet - this account's real Ekurhuleni statement (55 Loper Street) is
    // SHARED with Zelvio Global below (one physical municipal account billing both tenants) - see
    // the 2026-09 note on Zelvio Global's own entry below for why this needs a split decision from
    // the client before it can be imported, unlike Interoll/RCL Group/Colorobbia which each got
    // their own straightforward single-tenant statement this same batch.
    // Flagging still works with hasMunicipalStatements unset - flat_site_flagging_data.js just
    // shows the client-billing side only (Municipal Accounts table stays empty) until then.
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  // The following 4 - added 2026-08-20 alongside ADH Machine Tool above, all loose-standing sites on
  // the same "Loper Ave" tenant billing template (Ekurhuleni Tariff B, <=150A) - see
  // flat_site_tariff_shapes.js's EKURHULENI_TARIFF_B/EKURHULENI_TARIFF_B_SIMPLE header comments for
  // the shared-template formula quirks found across all 5. Interoll/RCL Group Services/Colorobbia
  // each got their own real municipal_import.js in 2026-09 (see each site's own entry below) - ADH
  // Machine Tool/Zelvio Global still don't, since their one shared 55 Loper Street municipal account
  // needs a split decision from the client first (see Zelvio Global's own note below).
  {
    slug: 'zelvio-global',
    name: '55 Loper Ave - Zelvio Global', // exactly as given on the client's own workbook - no legal suffix was provided for this one
    dbFile: 'zelvio-global.db',
    seedFile: './zelvio-global/import_history',
    billingModel: 'flat_site',
    // 2026-09: received the real Ekurhuleni municipal statement for 55 Loper Street (account
    // 1702343124) - but it bills BOTH this site AND ADH Machine Tool above under one account (one
    // physical building, one municipal meter set), and there's no existing data anywhere in either
    // site's own billing history (no tracked meter serials, floor-area split, or any other
    // convention) to derive how much of it belongs to each tenant - asked the client how to split it
    // before writing a municipal_import.js for either site.
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'interoll',
    name: '63 Loper Ave - Interoll',
    dbFile: 'interoll.db',
    seedFile: './interoll/import_history',
    billingModel: 'flat_site',
    // Real municipal account statement received 2026-09 (see interoll/municipal_import.js) - so the
    // "Recovery" nav tab applies here now, same as field-street/bob-martin/loper-road/etc.
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'rcl-group',
    name: '65 Loper Ave - RCL GROUP SERVICES (PTY) LTD',
    dbFile: 'rcl-group.db',
    seedFile: './rcl-group/import_history',
    billingModel: 'flat_site',
    // Real municipal account statement received 2026-09 (see rcl-group/municipal_import.js).
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
  {
    slug: 'colorobbia',
    name: '122 Loper - Colorobbia', // exactly as given on the client's own workbook (not "122 Loper Ave") - NOTE: its actual municipal account is billed to "13 Brussels Avenue", not any Loper address, see colorobbia/municipal_import.js
    dbFile: 'colorobbia.db',
    seedFile: './colorobbia/import_history',
    billingModel: 'flat_site',
    // Real municipal account statement received 2026-09 (see colorobbia/municipal_import.js).
    hasMunicipalStatements: true,
    hasFlagging: true,
    flaggingChartLayout: true,
  },
];
