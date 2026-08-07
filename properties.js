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
  },
  {
    slug: 'wingfield',
    name: 'Wingfield Business Park',
    dbFile: 'wingfield.db',
    seedFile: './wingfield/seed_wingfield', // added once a Wingfield workbook is imported - see README
    billingModel: 'tenant',
  },
  {
    slug: 'field-street',
    name: '8 Field Street',
    dbFile: 'field-street.db',
    seedFile: './field-street/seed',
    billingModel: 'flat_site',
    // Has a real municipal_import.js (see field-street/municipal_import.js) alongside its own
    // client billing - so the "Recovery" nav tab (tenant billing vs the real municipal bill, see
    // flat_site_recovery.js) applies here. Loper Road and Cranbrook Flavours don't have this flag -
    // no municipal statements have been imported for either yet.
    hasMunicipalStatements: true,
  },
  {
    slug: 'bob-martin',
    name: 'Bob Martin',
    dbFile: 'bob-martin.db',
    seedFile: './bob-martin/import_history',
    billingModel: 'flat_site',
    hasMunicipalStatements: true,
  },
  {
    slug: 'loper-road',
    name: 'Loper Road - Sandvic',
    dbFile: 'loper-road.db',
    seedFile: './loper-road/import_history',
    billingModel: 'flat_site',
  },
  {
    slug: 'autozone',
    name: 'AutoZone',
    dbFile: 'autozone.db',
    seedFile: './autozone/import_history',
    billingModel: 'flat_site',
    hasMunicipalStatements: true,
  },
  {
    slug: 'cranbrook-flavours',
    name: 'Cranbrook Flavours',
    dbFile: 'cranbrook-flavours.db',
    seedFile: './cranbrook-flavours/import_history',
    billingModel: 'flat_site',
  },
];
