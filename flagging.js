// flagging.js - property-agnostic statistics/classification engine for the "Flagging" tab (see
// city-deep/flagging_data.js for City Deep's own data-gathering layer that feeds this, and
// server.js's /flagging routes for how it's wired up). This file knows nothing about tenants,
// meters, or municipal accounts - it only ever operates on a plain chronological series of
// {label, consumption, billingDays} and turns that into a baseline + green/amber/red classification.
//
// This is a REPORTING tool only - nothing in this file writes to bills/bill_line_items or any other
// billing table, and nothing here is read by billing.js/calc.js. See the header comment on
// db.js's flag_settings/flag_annotations tables for why the flag level itself is never persisted
// (always recomputed live) while the human review trail (comments/status) is.
//
// ---------- Baseline math (spec section 2) ----------
// Every consumption figure is normalised to Average Daily Consumption (consumption / billingDays)
// before any comparison happens - this is what makes a 35-day municipal bill NOT get flagged just
// for covering more days than a 29-day previous bill (spec's own example). "3-month average",
// "6-month average" etc. below are all averages of each prior month's own average-daily rate, not
// raw monthly totals - so a run of variable-length billing periods doesn't skew the baseline either.
//
// ---------- Classification (spec sections 3-5) ----------
// classify() combines three checks, in this order:
//   1. Absolute-materiality gate (section 5) - if the Rand-equivalent change in consumption is
//      smaller than max(minAbsUnits, minAbsPctOfAvg% of the baseline's own monthly average), the
//      month is left green regardless of how large the percentage looks (a 50kWh -> 75kWh swing is
//      a real 50% jump but not one anyone needs to review).
//   2. Percentage-variance checks (section 3) - vs the historical baseline average AND vs the
//      immediately previous period, each with its own amber/red threshold since spec explicitly
//      wants a big single-month jump caught even if the multi-month baseline hasn't moved much yet.
//   3. Standard-deviation secondary check (section 4) - only attempted with >=6 months of prior
//      history, and only ever ESCALATES a level (never downgrades one raised by the pct checks) -
//      per the spec's explicit "do not rely on standard deviation alone" instruction.
// A billing-days explanatory note is appended whenever the latest period's length differs
// materially from the previous one, whether or not that ends up producing a flag - so a reviewer
// always sees WHY a period looks longer/shorter, not just the resulting number.
const LEVEL_RANK = { green: 0, amber: 1, red: 2 };
function worse(a, b) { return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function round1(n) { return Math.round(n * 10) / 10; }

// ---------- Settings (thresholds) ----------
const DEFAULT_SETTINGS = {
  amber_pct: 15, red_pct: 30, mom_amber_pct: 20, mom_red_pct: 40,
  stddev_amber: 1.5, stddev_red: 2.5, min_abs_kwh: 500, min_abs_kl: 5, min_abs_pct_of_avg: 5,
};
function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM flag_settings').all();
  const settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}
function updateSettings(db, updates) {
  const stmt = db.prepare(`INSERT INTO flag_settings (key, value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  for (const [key, value] of Object.entries(updates)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) && Number.isFinite(value)) stmt.run(key, value);
  }
}

// history: [{label, consumption, billingDays}], ascending chronological, last entry = the period
// being evaluated. Returns null if history is empty. label is expected 'YYYY-MM' so
// findSameMonthLastYear can do simple string arithmetic on it.
function findSameMonthLastYear(withDaily, latestLabel) {
  const [y, m] = latestLabel.split('-').map(Number);
  if (!y || !m) return null;
  const target = `${y - 1}-${String(m).padStart(2, '0')}`;
  return withDaily.find((r) => r.label === target) || null;
}

function computeSeriesStats(history) {
  if (!history || !history.length) return null;
  const withDaily = history.map((h) => ({ ...h, avgDaily: h.billingDays > 0 ? h.consumption / h.billingDays : 0 }));
  const latest = withDaily[withDaily.length - 1];
  const prior = withDaily.slice(0, -1); // ascending, excludes latest
  const priorDesc = [...prior].reverse(); // most-recent-prior-first
  const previous = prior.length ? prior[prior.length - 1] : null;

  const avgDailyOf = (n) => {
    const slice = priorDesc.slice(0, n);
    if (!slice.length) return null;
    return slice.reduce((s, r) => s + r.avgDaily, 0) / slice.length;
  };
  const avg3 = avgDailyOf(3), avg6 = avgDailyOf(6), avg12 = avgDailyOf(12);
  const sameMonthLastYear = findSameMonthLastYear(prior, latest.label);

  // Baseline window: prefer 6 prior months, fall back to however many exist (minimum 2 to be
  // meaningful at all - a single prior month is really just "vs previous month", already covered
  // separately below).
  const baselineMonths = prior.length >= 6 ? 6 : prior.length;
  const baselineSlice = priorDesc.slice(0, baselineMonths);
  const baselineAvgDaily = baselineMonths >= 2 ? baselineSlice.reduce((s, r) => s + r.avgDaily, 0) / baselineMonths : null;
  // "5% of the site's historical average MONTHLY consumption" (spec section 5) - this is each prior
  // month's own raw consumption, not avgDaily re-multiplied by a synthetic day count, so a genuinely
  // shorter/longer prior month doesn't distort what "monthly" means here.
  const baselineMonthlyAvg = baselineMonths >= 2 ? baselineSlice.reduce((s, r) => s + r.consumption, 0) / baselineMonths : null;

  let mean = null, stddev = null;
  if (prior.length >= 6) {
    const sample = priorDesc.slice(0, 12);
    mean = sample.reduce((s, r) => s + r.avgDaily, 0) / sample.length;
    const variance = sample.reduce((s, r) => s + (r.avgDaily - mean) ** 2, 0) / sample.length;
    stddev = Math.sqrt(variance);
  }

  return {
    latest, previous, avg3, avg6, avg12, sameMonthLastYear,
    baselineMonths, baselineAvgDaily, baselineMonthlyAvg, mean, stddev, priorCount: prior.length,
  };
}

// utility: 'electricity' | 'water' - decides which absolute-threshold unit (kWh vs kL) and which
// display unit label to use.
function classify(stats, settings, utility) {
  const unit = utility === 'water' ? 'kL' : 'kWh';
  if (!stats || stats.baselineAvgDaily == null || stats.priorCount < 2) {
    return {
      level: 'green', reasons: ['Not enough billing history yet to establish a baseline - shown for information only.'],
      insufficientHistory: true, pctVsBaseline: null, pctVsPrevious: null,
    };
  }

  const pctVsBaseline = stats.baselineAvgDaily > 0
    ? ((stats.latest.avgDaily - stats.baselineAvgDaily) / stats.baselineAvgDaily) * 100 : null;
  const pctVsPrevious = stats.previous && stats.previous.avgDaily > 0
    ? ((stats.latest.avgDaily - stats.previous.avgDaily) / stats.previous.avgDaily) * 100 : null;

  // Absolute-materiality gate (spec section 5) - compares this month's own consumption against the
  // baseline's monthly average, both as raw totals (not daily rates), since this check is about
  // whether the RAND-SIZE of the swing matters, not whether the rate-per-day looks different.
  const minAbsUnits = utility === 'water' ? settings.min_abs_kl : settings.min_abs_kwh;
  const minAbs = Math.max(minAbsUnits, (settings.min_abs_pct_of_avg / 100) * (stats.baselineMonthlyAvg || 0));
  const absVariance = Math.abs(stats.latest.consumption - (stats.baselineMonthlyAvg || 0));
  const zeroFlag = stats.latest.avgDaily <= 0 && stats.baselineAvgDaily > 0.1;
  const material = absVariance >= minAbs || zeroFlag;

  let level = 'green';
  const reasons = [];

  if (material) {
    if (zeroFlag) {
      level = 'red';
      reasons.push(`${cap(utility)} consumption is zero or unusually low this period, where meaningful consumption would normally be expected.`);
    }
    if (pctVsBaseline != null) {
      if (Math.abs(pctVsBaseline) > settings.red_pct) {
        level = worse(level, 'red');
        reasons.push(`${cap(utility)} consumption is ${round1(Math.abs(pctVsBaseline))}% ${pctVsBaseline > 0 ? 'higher' : 'lower'} than the ${stats.baselineMonths}-month average.`);
      } else if (Math.abs(pctVsBaseline) > settings.amber_pct) {
        level = worse(level, 'amber');
        reasons.push(`${cap(utility)} consumption is ${round1(Math.abs(pctVsBaseline))}% ${pctVsBaseline > 0 ? 'higher' : 'lower'} than the ${stats.baselineMonths}-month average.`);
      }
    }
    if (pctVsPrevious != null) {
      const verb = pctVsPrevious > 0 ? 'increased' : 'decreased';
      if (Math.abs(pctVsPrevious) > settings.mom_red_pct) {
        level = worse(level, 'red');
        reasons.push(`Average daily ${utility} consumption ${verb} from ${round1(stats.previous.avgDaily)} to ${round1(stats.latest.avgDaily)} ${unit}/day compared with the previous period.`);
      } else if (Math.abs(pctVsPrevious) > settings.mom_amber_pct) {
        level = worse(level, 'amber');
        reasons.push(`Average daily ${utility} consumption ${verb} from ${round1(stats.previous.avgDaily)} to ${round1(stats.latest.avgDaily)} ${unit}/day compared with the previous period.`);
      }
    }
  } else {
    reasons.push(`Change vs the historical average is below the minimum materiality threshold (${Math.round(minAbs)} ${unit}) - not flagged regardless of percentage.`);
  }

  // Secondary standard-deviation check (spec section 4) - can only ESCALATE, never used alone to
  // clear the immateriality gate above (spec: "do not rely on standard deviation alone").
  if (material && stats.stddev != null && stats.priorCount >= 6) {
    const z = stats.stddev > 0 ? (stats.latest.avgDaily - stats.mean) / stats.stddev : 0;
    if (Math.abs(z) > settings.stddev_red) {
      level = worse(level, 'red');
      reasons.push(`Latest average daily consumption is ${round1(Math.abs(z))} standard deviations from the historical mean - unusual even for a naturally variable site.`);
    } else if (Math.abs(z) > settings.stddev_amber) {
      level = worse(level, 'amber');
      reasons.push(`Latest average daily consumption is ${round1(Math.abs(z))} standard deviations from the historical mean.`);
    }
  }

  // Billing-days explanatory note - always surfaced when the period length changed materially,
  // regardless of the flag level, so a reviewer sees the "why" even when nothing gets flagged (spec's
  // own worked example: "...covers 36 days...Normalised consumption is within expected range.").
  if (stats.previous && Math.abs(stats.latest.billingDays - stats.previous.billingDays) >= 3) {
    reasons.push(`Billing period covers ${stats.latest.billingDays} days compared with ${stats.previous.billingDays} days in the previous period.${level === 'green' ? ' Normalised (per-day) consumption is within the expected range.' : ''}`);
  }
  if (level === 'red' && pctVsBaseline != null && pctVsBaseline < 0) {
    reasons.push('Consumption is well below historical levels - verify the municipal/meter reading before assuming this is genuine.');
  }
  if (!reasons.length) reasons.push('Within expected range.');

  return { level, reasons, pctVsBaseline, pctVsPrevious, absVariance, minAbs, material };
}

// Convenience: run computeSeriesStats + classify in one call, and shape the result the way
// city-deep/flagging_data.js's table rows want it.
function evaluate(history, settings, utility) {
  const stats = computeSeriesStats(history);
  const result = classify(stats, settings, utility);
  return { stats, ...result };
}

const EMOJI = { green: '\u{1F7E2}', amber: '\u{1F7E0}', red: '\u{1F534}' };

module.exports = {
  DEFAULT_SETTINGS, getSettings, updateSettings,
  computeSeriesStats, classify, evaluate, EMOJI, LEVEL_RANK, worse,
};
