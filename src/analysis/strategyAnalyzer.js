// ─────────────────────────────────────────────
//  analysis/strategyAnalyzer.js
//  Reads lifecycle/index.json and computes:
//  - Win rates per signal (what predicts ATH_BREAK / MOON)
//  - Optimal filter thresholds based on actual outcomes
//  - Scoring weights grounded in data
//  - Summary report posted to Discord weekly
// ─────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import createLogger from '../utils/logger.js';

const log = createLogger('STRATEGY');

const LIFECYCLE_DIR   = path.join(CONFIG.DATA_DIR, 'lifecycle');
const INDEX_FILE      = path.join(LIFECYCLE_DIR, 'index.json');
const ANALYSIS_FILE   = path.join(LIFECYCLE_DIR, 'strategy.json');

// ── Outcome grouping ───────────────────────────
// "Win" = ATH_BREAK or MOON (price went higher than listing)
// "Neutral" = RECOVERING (held near listing)
// "Loss" = DUMPED or OVER_DUMPED
const WIN_OUTCOMES     = new Set(['ATH_BREAK', 'MOON']);
const NEUTRAL_OUTCOMES = new Set(['RECOVERING']);
const LOSS_OUTCOMES    = new Set(['DUMPED', 'OVER_DUMPED']);

function isWin(outcome) { return WIN_OUTCOMES.has(outcome); }

// ── Load index ─────────────────────────────────

function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return [];
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (err) {
    log.error('Failed to load lifecycle index', { err: err.message });
    return [];
  }
}

// ── Core analysis ──────────────────────────────

export function runAnalysis() {
  const entries = loadIndex().filter(e => e.outcome !== 'UNKNOWN');

  if (entries.length < 10) {
    log.info(`Not enough data yet for analysis (${entries.length}/10 min)`);
    return null;
  }

  log.info(`Running strategy analysis on ${entries.length} completed lifecycles`);

  const total = entries.length;
  const wins  = entries.filter(e => isWin(e.outcome)).length;
  const baseWinRate = parseFloat(((wins / total) * 100).toFixed(1));

  // ── Signal analysis ────────────────────────
  // For each signal, compute: win rate with signal ON vs OFF

  const signals = analyzeSignals(entries);
  const thresholds = computeOptimalThresholds(entries);
  const outcomes = outcomeBreakdown(entries);
  const kolImpact = analyzeKOLImpact(entries);

  const analysis = {
    generatedAt:   new Date().toISOString(),
    sampleSize:    total,
    baseWinRate,
    outcomes,
    signals,
    thresholds,
    kolImpact,
    recommendations: buildRecommendations(signals, thresholds, baseWinRate),
  };

  // Save
  try {
    fs.writeFileSync(ANALYSIS_FILE, JSON.stringify(analysis, null, 2));
    log.info(`Strategy analysis saved`, { sampleSize: total, baseWinRate: baseWinRate + '%' });
  } catch (err) {
    log.error('Failed to save analysis', { err: err.message });
  }

  return analysis;
}

// ── Outcome breakdown ──────────────────────────

function outcomeBreakdown(entries) {
  const counts = {};
  for (const e of entries) {
    counts[e.outcome] = (counts[e.outcome] || 0) + 1;
  }
  const total = entries.length;
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, {
      count: v,
      pct: parseFloat(((v / total) * 100).toFixed(1)),
    }])
  );
}

// ── Signal analysis ────────────────────────────
// For each boolean/threshold signal, split entries into ON/OFF groups
// and compare win rates

function analyzeSignals(entries) {
  const results = {};

  // Bundle filter
  results.noBundle = splitSignal(entries, e => !e.isBundle);

  // Filter passed
  results.filterPassed = splitSignal(entries, e => e.filterPassed);

  // KOL at graduation
  results.kolAtGrad = splitSignal(entries, e => e.kolsAtGrad > 0);

  // KOL activity during tracking
  results.kolActivity = splitSignal(entries, e => e.kolActivityCount > 0);

  // Low dev hold (< 5%)
  results.lowDevHold = splitSignal(entries, e => e.devPct < 5);

  // Low top3 concentration (< 30%)
  results.lowTop3 = splitSignal(entries, e => e.top3Pct < 30);

  // Good holder score (>= 60)
  results.goodHolderScore = splitSignal(entries, e => e.holderScore >= 60);

  // Listed quickly (within 5 min of graduation)
  results.quickListing = splitSignal(entries, e => e.listedAtMins != null && e.listedAtMins <= 5);

  // Good liquidity at listing (>= $5k)
  results.goodLiquidity = splitSignal(entries, e => e.listingLiqUsd >= 5000);

  // Sufficient holders (>= 15)
  results.sufficientHolders = splitSignal(entries, e => e.holderCount >= 15);

  return results;
}

function splitSignal(entries, predicate) {
  const on  = entries.filter(predicate);
  const off = entries.filter(e => !predicate(e));

  const onWins  = on.filter(e => isWin(e.outcome)).length;
  const offWins = off.filter(e => isWin(e.outcome)).length;

  return {
    onCount:   on.length,
    offCount:  off.length,
    onWinRate: on.length  > 0 ? parseFloat(((onWins  / on.length)  * 100).toFixed(1)) : null,
    offWinRate:off.length > 0 ? parseFloat(((offWins / off.length) * 100).toFixed(1)) : null,
    lift:      (on.length > 0 && off.length > 0)
      ? parseFloat(((onWins / on.length) - (offWins / off.length)).toFixed(3))
      : null,
  };
}

// ── Optimal threshold computation ─────────────
// For continuous signals, find the threshold that maximizes win rate

function computeOptimalThresholds(entries) {
  return {
    top3Pct:      findOptimalThreshold(entries, 'top3Pct',      [20,25,30,35,40,45,50], 'below'),
    devPct:       findOptimalThreshold(entries, 'devPct',       [0,2,5,8,10,15],       'below'),
    holderCount:  findOptimalThreshold(entries, 'holderCount',  [5,10,15,20,25],       'above'),
    holderScore:  findOptimalThreshold(entries, 'holderScore',  [20,30,40,50,60,70],   'above'),
    liqUsd:       findOptimalThreshold(entries, 'listingLiqUsd',[1000,3000,5000,10000,20000], 'above'),
    athMultiplier: findDistribution(entries, 'athMultiplier'),
    maxDrawdown:   findDistribution(entries, 'maxDrawdownPct'),
  };
}

function findOptimalThreshold(entries, field, thresholds, direction) {
  let best = { threshold: null, winRate: 0, count: 0 };

  for (const t of thresholds) {
    const subset = direction === 'below'
      ? entries.filter(e => e[field] != null && e[field] <= t)
      : entries.filter(e => e[field] != null && e[field] >= t);

    if (subset.length < 5) continue;  // need at least 5 samples

    const wr = subset.filter(e => isWin(e.outcome)).length / subset.length;
    if (wr > best.winRate || best.threshold === null) {
      best = { threshold: t, winRate: parseFloat((wr * 100).toFixed(1)), count: subset.length };
    }
  }

  return best;
}

function findDistribution(entries, field) {
  const vals = entries.filter(e => e[field] != null).map(e => e[field]).sort((a,b)=>a-b);
  if (vals.length === 0) return null;

  const p25 = vals[Math.floor(vals.length * 0.25)];
  const p50 = vals[Math.floor(vals.length * 0.50)];
  const p75 = vals[Math.floor(vals.length * 0.75)];
  const p90 = vals[Math.floor(vals.length * 0.90)];

  const wins = entries.filter(e => e[field] != null && isWin(e.outcome));
  const wVals = wins.map(e => e[field]).sort((a,b)=>a-b);
  const wMedian = wVals.length > 0 ? wVals[Math.floor(wVals.length * 0.5)] : null;

  return { p25, p50, p75, p90, winnerMedian: wMedian, sampleSize: vals.length };
}

// ── KOL impact ────────────────────────────────

function analyzeKOLImpact(entries) {
  const withKOL    = entries.filter(e => e.kolsAtGrad > 0 || e.kolActivityCount > 0);
  const withoutKOL = entries.filter(e => e.kolsAtGrad === 0 && e.kolActivityCount === 0);

  const withWR    = withKOL.length    > 0 ? parseFloat(((withKOL.filter(e => isWin(e.outcome)).length    / withKOL.length)    * 100).toFixed(1)) : null;
  const withoutWR = withoutKOL.length > 0 ? parseFloat(((withoutKOL.filter(e => isWin(e.outcome)).length / withoutKOL.length) * 100).toFixed(1)) : null;

  // Which KOL names appear most in winning tokens
  const kolWinCounts = {};
  for (const e of entries.filter(e => isWin(e.outcome) && e.kolNames?.length > 0)) {
    for (const name of e.kolNames) {
      kolWinCounts[name] = (kolWinCounts[name] || 0) + 1;
    }
  }
  const topKOLs = Object.entries(kolWinCounts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, winningTokens: count }));

  return {
    withKOLCount:   withKOL.length,
    withoutKOLCount:withoutKOL.length,
    withKOLWinRate: withWR,
    withoutKOLWinRate: withoutWR,
    kolLift:        withWR != null && withoutWR != null
      ? parseFloat((withWR - withoutWR).toFixed(1))
      : null,
    topKOLsInWinners: topKOLs,
  };
}

// ── Build recommendations ────────────────────
// Translates signal analysis into config recommendations

function buildRecommendations(signals, thresholds, baseWinRate) {
  const recs = [];

  // Check each signal for meaningful lift (>= 10% improvement)
  for (const [name, data] of Object.entries(signals)) {
    if (data.lift !== null && data.lift >= 0.10 && data.onCount >= 5) {
      recs.push({
        signal:      name,
        finding:     `When ${name} = true, win rate is ${data.onWinRate}% vs ${data.offWinRate}% base`,
        lift:        `+${(data.lift * 100).toFixed(1)}pp`,
        action:      `Keep/strengthen this filter — strong positive signal`,
        sampleSize:  data.onCount,
      });
    } else if (data.lift !== null && data.lift <= -0.10 && data.offCount >= 5) {
      recs.push({
        signal:      name,
        finding:     `${name} filter may be hurting: off=${data.offWinRate}% vs on=${data.onWinRate}%`,
        lift:        `${(data.lift * 100).toFixed(1)}pp`,
        action:      `Consider relaxing this filter — may be filtering good tokens`,
        sampleSize:  data.offCount,
      });
    }
  }

  // Threshold recommendations
  if (thresholds.top3Pct?.winRate > baseWinRate + 10) {
    recs.push({
      signal:  'MAX_TOP3_CONCENTRATION',
      finding: `Optimal top3 threshold: ≤${thresholds.top3Pct.threshold}% gives ${thresholds.top3Pct.winRate}% win rate`,
      action:  `Set FILTERS.MAX_TOP3_CONCENTRATION = ${thresholds.top3Pct.threshold}`,
    });
  }

  if (thresholds.liqUsd?.winRate > baseWinRate + 10) {
    recs.push({
      signal:  'MIN_LIQUIDITY_USD',
      finding: `Tokens with ≥$${thresholds.liqUsd.threshold} liquidity at listing: ${thresholds.liqUsd.winRate}% win rate`,
      action:  `Consider filtering for min listing liquidity`,
    });
  }

  return recs;
}

// ── Format for Discord ────────────────────────

export function formatAnalysisForDiscord(analysis) {
  if (!analysis) return null;

  const { sampleSize, baseWinRate, outcomes, signals, kolImpact, recommendations } = analysis;

  const outcomeLines = Object.entries(outcomes)
    .sort((a,b) => b[1].count - a[1].count)
    .map(([k,v]) => `${k}: ${v.count} (${v.pct}%)`)
    .join('\n');

  const topSignals = Object.entries(signals)
    .filter(([,d]) => d.lift !== null)
    .sort((a,b) => Math.abs(b[1].lift) - Math.abs(a[1].lift))
    .slice(0, 5)
    .map(([name, d]) => `${name}: ${d.onWinRate}% vs ${d.offWinRate}% (${d.lift >= 0 ? '+' : ''}${(d.lift*100).toFixed(1)}pp)`)
    .join('\n');

  const kolLines = kolImpact.withKOLWinRate !== null
    ? `With KOL: ${kolImpact.withKOLWinRate}% (n=${kolImpact.withKOLCount})\nWithout KOL: ${kolImpact.withoutKOLWinRate}% (n=${kolImpact.withoutKOLCount})`
    : 'Not enough data';

  const recLines = recommendations.slice(0, 3)
    .map(r => `• ${r.signal}: ${r.action}`)
    .join('\n') || 'No strong recommendations yet';

  return {
    title: `📊 Strategy Analysis (n=${sampleSize})`,
    baseWinRate: `${baseWinRate}%`,
    outcomeLines,
    topSignals,
    kolLines,
    recLines,
  };
}

// ── Auto-run on schedule ───────────────────────

export function startAnalysisScheduler(sendFn) {
  const TWENTY_MINS = 20 * 60_000;

  // Run once at startup after 2 min to let first data arrive
  setTimeout(() => {
    const result = runAnalysis();
    if (result && sendFn) sendFn(result);
  }, 2 * 60_000);

  setInterval(() => {
    const result = runAnalysis();
    if (result && sendFn) sendFn(result);
  }, TWENTY_MINS);

  log.info('Strategy analysis scheduler started (every 20 min)');
}