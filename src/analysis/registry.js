// ─────────────────────────────────────────────
//  analysis/registry.js  —  Token Registry
//
//  Migration-only model:
//    - Tokens enter registry ONLY when they graduate (subscribeMigration)
//    - Enrichment (holders + bundle) runs immediately on graduation
//    - Trade tracking begins post-graduation via subscribeTokenTrade
//    - Score loop runs on graduated tokens only
//
//  No pre-graduation tracking. No 30k token firehose.
// ─────────────────────────────────────────────

import EventEmitter from 'events';
import { CONFIG } from '../config.js';
import { TokenStore, SnapshotStore } from '../storage/storage.js';
import { computeScore, checkSignalThreshold } from './scorer.js';
import { takeHolderSnapshot, detectBundle, applyFilters } from '../enrichment/holderAnalysis.js';
import createLogger from '../utils/logger.js';

const log = createLogger('REGISTRY');

class TokenRegistry extends EventEmitter {
  constructor() {
    super();
    // In-memory map: mint → token state
    this.tokens = new Map();
    // Track enrichment done
    this._enriched = new Set();
    // Alert cooldown tracker
    this.alerted = new Map();  // mint → { level, ts }
    this.stats = {
      totalGraduated:   0,
      totalEnriched:    0,
      totalFiltered:    0,
      totalSignals:     0,
      totalTradeAlerts: 0,
      startedAt:        Date.now(),
    };
  }

  // ── Graduation — primary entry point ──────────
  // Called when subscribeMigration fires.
  // Token is created here for the first time.

  onGraduation(gradData) {
    const { mint } = gradData;

    if (this.tokens.has(mint)) {
      log.debug(`Duplicate graduation event ignored: ${mint.slice(0, 8)}...`);
      return;
    }

    this.stats.totalGraduated++;

    const token = {
      // Identity — from migration event (may be sparse, enriched later)
      mint,
      name:         gradData.name         || 'Unknown',
      symbol:       gradData.symbol       || mint.slice(0, 6).toUpperCase(),
      creator:      gradData.creator      || null,
      bondingCurve: gradData.bondingCurve || null,
      pool:         gradData.pool         || null,
      poolAddress:  gradData.poolAddress  || null,

      // State — starts as GRADUATED, always
      stage:           'GRADUATED',
      bondingPct:      100,
      marketCapSol:    gradData.marketCapSol || 0,

      // Post-graduation trade aggregates (populated via subscribeTokenTrade)
      buyCount:        0,
      sellCount:       0,
      totalVolumeSol:  0,
      uniqueBuyers:    new Set(),
      uniqueSellers:   new Set(),
      lastTradeSol:    0,
      lastPriceUsd:    0,

      // Timestamps
      graduatedAt:     gradData.ts || Date.now(),
      lastTradeAt:     Date.now(),

      // Enrichment (filled async)
      holderSnapshot:  null,
      bundleResult:    null,
      filterResult:    null,
      scoreResult:     null,

      txSignature:     gradData.signature || null,
    };

    this.tokens.set(mint, token);
    TokenStore.save(this._serializeToken(token));

    log.info(`🎓 GRADUATED token registered: [${token.symbol}] ${mint.slice(0, 8)}...`, {
      pool:        token.pool,
      totalTracking: this.tokens.size,
    });

    // Immediately: subscribe to trade feed + run enrichment
    this.emit('startTracking', token);
    this._runEnrichment(token);
    this.emit('graduated', token, gradData);
  }

  // ── Trade processing ──────────────────────────
  // Only called for mints we explicitly subscribed to post-graduation

  onTrade(tradeData) {
    const token = this.tokens.get(tradeData.mint);
    if (!token) {
      log.debug(`Trade for untracked mint ignored: ${tradeData.mint.slice(0, 8)}...`);
      return;
    }

    token.marketCapSol  = tradeData.marketCapSol || token.marketCapSol;
    token.lastTradeAt   = tradeData.ts;
    token.lastTradeSol  = tradeData.solAmount;
    token.totalVolumeSol += tradeData.solAmount || 0;

    if (tradeData.type === 'buy') {
      token.buyCount++;
      token.uniqueBuyers.add(tradeData.trader);
    } else {
      token.sellCount++;
      token.uniqueSellers.add(tradeData.trader);
    }

    log.debug(`💱 ${tradeData.type.toUpperCase()} [${token.symbol}] ${token.mint.slice(0, 8)}...`, {
      sol:    tradeData.solAmount.toFixed(4),
      mcap:   token.marketCapSol.toFixed(2),
      trader: tradeData.trader.slice(0, 8) + '...',
    });

    if ((token.buyCount + token.sellCount) % 5 === 0) {
      TokenStore.save(this._serializeToken(token));
    }

    this.emit('trade', token, tradeData);
  }

  // ── Score recalculation loop ──────────────────
  // Runs only on graduated tokens that passed enrichment

  startScoreLoop() {
    log.info(`Starting score loop (every ${CONFIG.INTERVALS.SCORE_RECALC_MS / 1000}s)`);

    setInterval(() => {
      let recalcCount = 0;
      for (const [mint, token] of this.tokens) {
        if (!this._enriched.has(mint)) continue; // skip unenriched

        const scoreResult = computeScore(
          { ...this._serializeToken(token), uniqueBuyers: token.uniqueBuyers.size },
          token.holderSnapshot,
          token.bundleResult
        );
        token.scoreResult = scoreResult;
        recalcCount++;

        const signal = checkSignalThreshold(scoreResult, this._serializeToken(token));
        if (signal.shouldAlert) {
          this._maybeEmitAlert(token, signal);
        }

        SnapshotStore.append(mint, {
          marketCapSol:  token.marketCapSol,
          volumeSol:     token.totalVolumeSol,
          buyCount:      token.buyCount,
          sellCount:     token.sellCount,
          uniqueBuyers:  token.uniqueBuyers.size,
          score:         scoreResult.score,
          price:         token.lastPriceUsd || 0,
        });
      }
      if (recalcCount > 0) {
        log.debug(`Score loop recalculated ${recalcCount} graduated tokens`);
      }
    }, CONFIG.INTERVALS.SCORE_RECALC_MS);
  }

  // ── Cleanup loop ──────────────────────────────

  startCleanupLoop() {
    log.info(`Starting cleanup loop (every ${CONFIG.INTERVALS.CLEANUP_MS / 1000}s)`);

    setInterval(() => {
      const now = Date.now();
      const staleCutoff = CONFIG.GRADUATED_TRACK_MINS * 60 * 1000;
      let removed = 0;

      for (const [mint, token] of this.tokens) {
        const age = now - token.graduatedAt;
        if (age > staleCutoff) {
          log.debug(`Cleanup: ${token.symbol} tracking window expired (${(age / 60000).toFixed(0)}m old)`);
          this.tokens.delete(mint);
          this._enriched.delete(mint);
          removed++;
        }
      }

      if (removed > 0) {
        log.info(`Cleanup removed ${removed} expired tokens. Active: ${this.tokens.size}`);
      }
    }, CONFIG.INTERVALS.CLEANUP_MS);
  }

  // ── Enrichment ────────────────────────────────
  // Runs immediately after graduation: holders + bundle check

  async _runEnrichment(token) {
    log.info(`🔬 Running enrichment: [${token.symbol}] ${token.mint.slice(0, 8)}...`);

    try {
      // Fetch pump.fun metadata to get live MCap USD for Mayhem filter
      let listingMcapUsd = null;
      try {
        const pumpRes = await fetch(`https://frontend-api.pump.fun/coins/${token.mint}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (pumpRes.ok) {
          const pumpData = await pumpRes.json();
          listingMcapUsd = pumpData.usd_market_cap || null;
          // Also update name/symbol from pump.fun if we have mint-slice placeholder
          if (pumpData.name && (!token.name || token.name === 'Unknown')) {
            token.name   = pumpData.name;
            token.symbol = pumpData.symbol || token.symbol;
            log.info(`Updated token name from pump.fun: [${token.symbol}] ${token.name}`);
          }
          if (listingMcapUsd) {
            log.info(`pump.fun MCap for Mayhem filter: $${listingMcapUsd.toFixed(0)}`, {
              mint: token.mint.slice(0, 8),
            });
          }
          // Save image for Discord embed thumbnail
          if (pumpData.image_uri && !token.imageUrl) {
            token.imageUrl = pumpData.image_uri;
          }
        }
      } catch { /* non-fatal — enrichment continues without MCap check */ }

      const [holderResult, bundleResult] = await Promise.allSettled([
        takeHolderSnapshot(token.mint, token.creator),
        detectBundle(token.mint),
      ]);

      token.holderSnapshot = holderResult.status === 'fulfilled' ? holderResult.value : null;
      token.bundleResult   = bundleResult.status  === 'fulfilled' ? bundleResult.value  : null;

      if (holderResult.status === 'rejected') {
        log.error(`Holder snapshot failed: [${token.symbol}]`, { err: holderResult.reason?.message });
      }
      if (bundleResult.status === 'rejected') {
        log.error(`Bundle check failed: [${token.symbol}]`, { err: bundleResult.reason?.message });
      }

      const filterResult = applyFilters(
        token.holderSnapshot,
        token.bundleResult,
        this._serializeToken(token),
        listingMcapUsd  // pass live MCap for Mayhem filter
      );
      token.filterResult = filterResult;
      token.listingMcapUsd = listingMcapUsd;
      this.stats.totalEnriched++;

      if (!filterResult.pass) {
        this.stats.totalFiltered++;
        log.warn(`❌ FILTERED: [${token.symbol}] ${token.mint.slice(0, 8)}...`, {
          reasons: filterResult.reasons.join(' | '),
        });
      } else {
        log.info(`✅ PASSED filters: [${token.symbol}] ${token.mint.slice(0, 8)}...`);
      }

      this._enriched.add(token.mint);
      TokenStore.save(this._serializeToken(token));
      this.emit('enriched', token, filterResult);

    } catch (err) {
      log.error(`Enrichment crashed: [${token.symbol}]`, { err: err.message });
    }
  }

  // ── Alert deduplication ───────────────────────

  _maybeEmitAlert(token, signal) {
    const lastAlert = this.alerted.get(token.mint);
    const COOLDOWN = 5 * 60 * 1000;

    if (lastAlert?.level === signal.level && Date.now() - lastAlert.ts < COOLDOWN) return;

    this.alerted.set(token.mint, { level: signal.level, ts: Date.now() });
    this.stats.totalSignals++;
    if (signal.level === 'TRADE_ALERT') this.stats.totalTradeAlerts++;

    log.info(`🚨 ALERT: ${signal.level} [${token.symbol}]`, {
      score:  token.scoreResult?.score,
      reason: signal.reason,
    });

    this.emit('alert', token, signal);
  }

  // ── Serializer ────────────────────────────────

  _serializeToken(token) {
    return {
      ...token,
      uniqueBuyers:  token.uniqueBuyers  instanceof Set ? token.uniqueBuyers.size  : token.uniqueBuyers,
      uniqueSellers: token.uniqueSellers instanceof Set ? token.uniqueSellers.size : token.uniqueSellers,
    };
  }

  // ── Public ────────────────────────────────────

  getToken(mint) { return this.tokens.get(mint); }

  // Expose enriched set so index.js can check it
  get enriched() { return this._enriched; }

  getStats() {
    return {
      ...this.stats,
      activeTokens:   this.tokens.size,
      enrichedTokens: this._enriched.size,
      uptimeMs:       Date.now() - this.stats.startedAt,
    };
  }
}

export const registry = new TokenRegistry();