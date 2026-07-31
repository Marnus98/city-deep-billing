// properties.js - registry of the physical properties this platform manages. Each property gets
// its own completely separate SQLite database file (see db.js's open(fileName)) so there is no
// shared table for a missed WHERE clause to leak one property's tenants/bills/tariffs into
// another's - the isolation is physical (different file), not a query-level filter.
//
// The one thing NOT listed here is logins: `users` lives in its own shared data/auth.db (see
// server.js) so one set of credentials works across every property in this list.
//
// To add a new property: add an entry here (dbFile should be unique), then build a folder the
// same way city-deep/ and wingfield/ were built - its own seed_<slug>.js (copy the pattern from
// wingfield/seed_wingfield.js), its own imports/ subfolder for the extracted workbook JSON, and
// set seedFile below to require() it.
//
// Each property's own code+data lives in its own top-level folder (city-deep/, wingfield/) so
// the two don't get interleaved in one flat directory listing - only genuinely shared platform
// code (server.js, views.js, db.js, billing.js, calc.js, etc.) lives at the repo root.
module.exports = [
  {
    slug: 'city-deep',
    name: 'City Deep Industrial Park',
    dbFile: 'city-deep.db',
    seedFile: './city-deep/seed',
  },
  {
    slug: 'wingfield',
    name: 'Wingfield Business Park',
    dbFile: 'wingfield.db',
    seedFile: './wingfield/seed_wingfield', // added once a Wingfield workbook is imported - see README
  },
];
