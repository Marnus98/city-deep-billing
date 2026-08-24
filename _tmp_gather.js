const { open, migrate } = require('./db');
const flatSiteRecovery = require('./flat_site_recovery');
const tenantRecovery = require('./tenant_recovery');
const cityDeepGroups = require('./city-deep/recovery_groups');

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function analyze(rows, periodFieldFor) {
  // rows ascending. Compute per-utility per-month avg/day + variance, plus totals.
  const utilities = [
    { key: 'elec', randKey: 'elecRand', qtyKey: 'elecKwh', unit: 'kWh', periodField: 'elec' },
    { key: 'water', randKey: 'waterRand', qtyKey: 'waterKl', unit: 'kL', periodField: 'water' },
    { key: 'sewer', randKey: 'sewerRand', qtyKey: 'sewerKl', unit: 'kL', periodField: 'water' },
  ];
  const out = {};
  for (const u of utilities) {
    const monthRows = [];
    let sumOurRand = 0, sumMuniRand = 0, sumOurQty = 0, sumMuniQty = 0;
    for (const r of rows) {
      const site = r.site, muni = r.municipal;
      if (!site || !muni) { monthRows.push({ label: r.label, noData: true }); continue; }
      const ourDays = daysBetween(site.startDate, site.endDate);
      const muniStart = u.periodField === 'water' ? (muni.waterStartDate || muni.startDate) : muni.startDate;
      const muniEnd = u.periodField === 'water' ? (muni.waterEndDate || muni.endDate) : muni.endDate;
      const muniDays = daysBetween(muniStart, muniEnd);
      const ourQty = site[u.qtyKey], muniQty = muni[u.qtyKey];
      const ourAvg = ourDays ? ourQty / ourDays : null;
      const muniAvg = muniDays ? muniQty / muniDays : null;
      const variancePct = muniQty ? ((ourQty - muniQty) / muniQty) * 100 : null;
      sumOurRand += site[u.randKey] || 0; sumMuniRand += muni[u.randKey] || 0;
      sumOurQty += ourQty || 0; sumMuniQty += muniQty || 0;
      monthRows.push({
        label: r.label, ourRand: site[u.randKey], muniRand: muni[u.randKey],
        recoveryRand: site[u.randKey] - muni[u.randKey],
        ourQty, muniQty, ourDays, muniDays, ourAvg, muniAvg, variancePct,
      });
    }
    out[u.key] = {
      months: monthRows,
      totalOurRand: sumOurRand, totalMuniRand: sumMuniRand, totalRecoveryRand: sumOurRand - sumMuniRand,
      totalOurQty: sumOurQty, totalMuniQty: sumMuniQty,
    };
  }
  return out;
}

const sites = [];

// Flat-site properties
const flatProps = [
  { slug: 'field-street', name: '8 Field Street', dbFile: 'field-street.db' },
  { slug: 'bob-martin', name: 'Bob Martin', dbFile: 'bob-martin.db' },
  { slug: 'loper-road', name: 'Loper Road - Sandvic', dbFile: 'loper-road.db' },
  { slug: 'autozone', name: 'AutoZone', dbFile: 'autozone.db' },
  { slug: 'cranbrook-flavours', name: 'Cranbrook Flavours', dbFile: 'cranbrook-flavours.db' },
];
for (const p of flatProps) {
  const db = open(p.dbFile);
  migrate(db);
  const rows = flatSiteRecovery.buildRecoveryRows(db, { limit: 24 });
  sites.push({ slug: p.slug, name: p.name, section: null, analysis: analyze(rows) });
  db.close();
}

// Wingfield
{
  const db = open('wingfield.db');
  migrate(db);
  const rows = tenantRecovery.buildRecoveryRows(db, 'Wingfield Business Park', { limit: 24 });
  sites.push({ slug: 'wingfield', name: 'Wingfield Business Park', section: null, analysis: analyze(rows) });
  db.close();
}

// City Deep - 3 sections
{
  const db = open('city-deep.db');
  migrate(db);
  for (const sec of cityDeepGroups.SECTIONS) {
    const tenantNames = cityDeepGroups.tenantNamesForSection(db, sec.key);
    const rows = tenantRecovery.buildRecoveryRowsForTenants(db, sec.siteNameForMunicipal, tenantNames, { limit: 24 });
    sites.push({ slug: 'city-deep-' + sec.key, name: 'City Deep Industrial Park', section: sec.title, analysis: analyze(rows) });
  }
  db.close();
}

require('fs').writeFileSync('/tmp/recovery_data.json', JSON.stringify(sites, null, 2));
console.log('Wrote', sites.length, 'site datasets');
for (const s of sites) {
  console.log('-', s.name, s.section || '', ': elec months=', s.analysis.elec.months.length, ' totalRecoveryElec=', s.analysis.elec.totalRecoveryRand.toFixed(0), ' totalRecoveryWater=', s.analysis.water.totalRecoveryRand.toFixed(0));
}
