// ─────────────────────────────────────────────
//  analysis/scorer.js
//  Stage classification + Signal detection + Token scoring
// ─────────────────────────────────────────────

import { CONFIG } from '../config.js';
import { SnapshotStore } from '../storage/storage.js';
import createLogger from '../utils/logger.js';

const log = createLogger('SCORER');

// ── Stage Classifier ───────────────────────────

/**
 * Classify token stage by bonding curve %
 * Returns: 'LAUNCH' | 'EARLY_GROWTH' | 'MOMENTUM' | 'BONDING_ZONE' | 'GRADUATED'
 */
export function classifyStage(bondingPct) {
  if (bondingPct >= 100) return 'GRADUATED';
  if (bondingPct >= 75)  return 'BONDING_ZONE';
  if (bondingPct >= 50)  return 'MOMENTUM';
  if (bondingPct >= 20)  return 'EARLY_GROWTH';
  return 'LAUNCH';
}

const STAGE_EMOJI = {
  LAUNCH:       '🟠',
  EARLY_GROWTH: '🟡',
  MOMENTUM:     '🔵',
  BONDING_ZONE: '🟢',
  GRADUATED:    '🎓',
};

export function stageEmoji(stage) { return STAGE_EMOJI[stage] || '⚪'; }

// ── Trade State Machine ────────────────────────
// States post-graduation:
//  LISTING → price stable/rising
//  DUMPING → price dropping from listing
//  ENTRY_ZONE → drop in [15%, 45%] range — BUY SIGNAL
//  RECOVERING → price bouncing from dump bottom
//  ATH_RETEST → approaching ATH
//  COMPLETED → ATH broken or signal expired

export function classifyTradeState(tradeTracking) {
  if (!tradeTracking?.listingPrice || tradeTracking.listingPrice === 0) return 'LISTING';

  const { listingPrice, currentPrice, ath } = tradeTracking;
  if (!currentPrice) return 'LISTING';

  const dropFromListing = ((listingPrice - currentPrice) / listingPrice) * 100;
  const fromATH = ath ? ((ath - currentPrice) / ath) * 100 : 0;

  if (dropFromListing >= CONFIG.DUMP_ENTRY_DROP_PCT && dropFromListing <= CONFIG.DUMP_ENTRY_MAX_DROP) {
    return 'ENTRY_ZONE';
  }
  if (dropFromListing > CONFIG.DUMP_ENTRY_MAX_DROP) return 'OVER_DUMPED';
  if (fromATH < 5 && ath) return 'ATH_RETEST';
  if (dropFromListing > 5) return 'DUMPING';
  return 'LISTING';
}

// ── Score Engine ───────────────────────────────

/**
 * Compute composite token score (0-100)
 * Higher = stronger buy signal
 *
 * Inputs:
 * - token: the token object from registry
 * - holderSnapshot: from holderAnalysis
 * - bundleResult: from bundleDetection
 */
export function computeScore(token, holderSnapshot = null, bundleResult = null) {
  log.debug(`Computing score for ${token.mint.slice(0, 8)}...`, { stage: token.stage });

  const weights = CONFIG.SCORE_WEIGHTS;
  let components = {};

  // 1. Bonding % score (0-100 maps to 0-100)
  components.bondingPercent = Math.min(100, token.bondingPct || 0);

  // 2. Volume velocity score
  const volVelocity = SnapshotStore.getVolumeVelocity(token.mint, 4);  // SOL/min
  // Scale: 0 SOL/min = 0, 5+ SOL/min = 100
  components.volumeVelocity = Math.min(100, (volVelocity / 5) * 100);

  // 3. Unique buyers score
  const buyers = token.uniqueBuyers || 0;
  // Scale: 0 = 0, 200+ = 100
  components.uniqueBuyers = Math.min(100, (buyers / 200) * 100);

  // 4. Buy pressure score (from live trades)
  const buyCount  = token.buyCount  || 0;
  const sellCount = token.sellCount || 0;
  const totalTrades = buyCount + sellCount;
  const buyPressurePct = totalTrades > 0 ? (buyCount / totalTrades) * 100 : 50;
  // 50% neutral = 50 score, 80%+ buys = 100, 20% buys = 0
  components.buyPressure = Math.min(100, Math.max(0, (buyPressurePct - 20) * (100 / 60)));

  // 5. Holder score
  components.holderScore = holderSnapshot?.holderScore ?? 50;

  // 6. Bundle clean score
  if (bundleResult?.isBundle) {
    components.bundleClean = Math.max(0, 100 - bundleResult.confidence);
  } else {
    components.bundleClean = bundleResult ? 100 : 70; // 70 if unchecked, 100 if clean
  }

  // Weighted sum
  let totalScore = 0;
  for (const [key, val] of Object.entries(components)) {
    totalScore += (weights[key] || 0) * val;
  }
  totalScore = Math.round(Math.min(100, Math.max(0, totalScore)));

  log.debug(`Score breakdown for ${token.mint.slice(0, 8)}...`, {
    ...Object.fromEntries(Object.entries(components).map(([k, v]) => [k, Math.round(v)])),
    TOTAL: totalScore,
  });

  return {
    score: totalScore,
    components,
    grade: scoreGrade(totalScore),
    ts: Date.now(),
  };
}

function scoreGrade(score) {
  if (score >= 85) return 'A+';
  if (score >= 75) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

// ── Signal Emitter ─────────────────────────────

/**
 * Check if a token should trigger a signal alert
 * Returns { shouldAlert, reason, level }
 */
export function checkSignalThreshold(scoreResult, token) {
  const { score } = scoreResult;

  if (score >= CONFIG.TRADE_ALERT_SCORE_MIN) {
    log.info(`🔥 TRADE ALERT threshold hit for ${token.mint.slice(0, 8)}...`, {
      score,
      stage: token.stage,
      bonding: token.bondingPct?.toFixed(1) + '%',
    });
    return { shouldAlert: true, level: 'TRADE_ALERT', reason: `Score ${score} (grade ${scoreResult.grade}) in ${token.stage}` };
  }

  if (score >= CONFIG.SIGNAL_SCORE_MIN) {
    log.info(`📡 SIGNAL threshold hit for ${token.mint.slice(0, 8)}...`, { score, stage: token.stage });
    return { shouldAlert: true, level: 'SIGNAL', reason: `Score ${score} (grade ${scoreResult.grade}) in ${token.stage}` };
  }

  return { shouldAlert: false, level: null, reason: null };
}
