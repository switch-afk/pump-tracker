// ─────────────────────────────────────────────
//  analysis/graduationTracker.js
//  Monitors newly graduated tokens on DEX
//  Detects the initial dump → fires entry signals
// ─────────────────────────────────────────────

import EventEmitter from 'events';
import { CONFIG } from '../config.js';
import { GraduatedStore } from '../storage/storage.js';
import { getBestPair, analyzeDump } from '../enrichment/dexscreener.js';
import { classifyTradeState } from './scorer.js';
import createLogger from '../utils/logger.js';

const log = createLogger('GRAD-TRACKER');

class GraduationTracker extends EventEmitter {
  constructor() {
    super();
    // mint → { token, pollInterval, listingPrice, startedAt, lastState }
    this.watching = new Map();
  }

  /**
   * Start tracking a graduated token
   * @param {object} token — from registry, serialized
   */
  startTracking(token) {
    if (this.watching.has(token.mint)) {
      log.debug(`Already watching graduated token: ${token.mint.slice(0, 8)}...`);
      return;
    }

    log.info(`🔭 Starting graduation tracking: ${token.symbol} (${token.mint.slice(0, 8)}...)`, {
      score: token.scoreResult?.score || 'unscored',
      filterPass: token.filterResult?.pass,
    });

    // Record in graduated store
    GraduatedStore.add(token);

    const state = {
      token,
      listingPrice: null,
      ath: null,
      lowestPrice: null,
      lastPair: null,
      lastState: 'LISTING',
      startedAt: Date.now(),
      pollCount: 0,
    };
    this.watching.set(token.mint, state);

    // Initial poll with slight delay (give DEX time to index)
    setTimeout(() => this._poll(token.mint), 8000);

    // Regular poll interval
    const interval = setInterval(() => {
      this._poll(token.mint);
    }, CONFIG.INTERVALS.DEXSCREENER_POLL_MS);

    state.interval = interval;

    // Auto-stop after GRADUATED_TRACK_MINS
    setTimeout(() => {
      log.info(`⏱ Graduation tracking window expired: ${token.symbol}`, {
        trackedFor: `${CONFIG.GRADUATED_TRACK_MINS} min`,
      });
      this.stopTracking(token.mint, 'time_expired');
    }, CONFIG.GRADUATED_TRACK_MINS * 60 * 1000);
  }

  async _poll(mint) {
    const state = this.watching.get(mint);
    if (!state) return;

    state.pollCount++;
    log.debug(`Polling graduated token: ${state.token.symbol} (poll #${state.pollCount})`);

    try {
      const pair = await getBestPair(mint);
      if (!pair) {
        log.warn(`No DEX pair found yet for ${state.token.symbol} (poll #${state.pollCount})`);
        return;
      }

      state.lastPair = pair;

      // ── On first successful poll: set listing price + update name/symbol from DEX ──
      if (!state.listingPrice) {
        state.listingPrice = pair.priceUsd;

        // DexScreener returns baseToken.name and baseToken.symbol — update token if we only have mint slice
        if (pair.baseTokenName && (!state.token.name || state.token.name === 'Unknown')) {
          state.token.name   = pair.baseTokenName;
          state.token.symbol = pair.baseTokenSymbol || state.token.symbol;
          log.info(`Updated token name from DexScreener: [${state.token.symbol}] ${state.token.name}`);
        }

        log.info(`💰 Listing price set for ${state.token.symbol}`, {
          priceUsd: pair.priceUsd.toFixed(8),
          liqUsd: pair.liquidityUsd.toFixed(0),
          dex: pair.dex,
        });

        GraduatedStore.updateTradeTracking(mint, {
          listingPrice: state.listingPrice,
          currentPrice: pair.priceUsd,
          ath: pair.priceUsd,
        });

        state.ath = pair.priceUsd;
        state.lowestPrice = pair.priceUsd;

        this.emit('listed', state.token, pair, state.listingPrice);
        return;
      }

      // Update ATH
      if (pair.priceUsd > state.ath) {
        state.ath = pair.priceUsd;
        GraduatedStore.updateTradeTracking(mint, { ath: state.ath });
        log.info(`📈 New ATH for ${state.token.symbol}: $${state.ath.toFixed(8)}`);
      }

      // Update lowest
      if (pair.priceUsd < state.lowestPrice) {
        state.lowestPrice = pair.priceUsd;
        GraduatedStore.updateTradeTracking(mint, { lowestAfterListing: state.lowestPrice });
      }

      // Update current
      GraduatedStore.updateTradeTracking(mint, { currentPrice: pair.priceUsd });

      // Compute trade state
      const tradeTracking = {
        listingPrice: state.listingPrice,
        currentPrice: pair.priceUsd,
        ath: state.ath,
      };
      const tradeState = classifyTradeState(tradeTracking);

      log.info(`📊 ${state.token.symbol} state=${tradeState}`, {
        priceUsd: pair.priceUsd.toFixed(8),
        dropFromListing: state.listingPrice
          ? (((state.listingPrice - pair.priceUsd) / state.listingPrice) * 100).toFixed(2) + '%'
          : 'n/a',
        buyPressure: pair.txns5m_buys + '/' + (pair.txns5m_buys + pair.txns5m_sells),
        vol5m: pair.vol5m.toFixed(0),
        liqUsd: pair.liquidityUsd.toFixed(0),
      });

      // State transition
      if (tradeState !== state.lastState) {
        log.info(`🔄 Trade state transition: ${state.token.symbol} ${state.lastState} → ${tradeState}`);
        state.lastState = tradeState;
        this.emit('stateChange', state.token, tradeState, pair);
      }

      // ENTRY SIGNAL
      if (tradeState === 'ENTRY_ZONE') {
        const { dropPct } = analyzeDump(pair, state.listingPrice);

        log.info(`🎯 ENTRY SIGNAL: ${state.token.symbol}`, {
          listingPrice: state.listingPrice.toFixed(8),
          currentPrice: pair.priceUsd.toFixed(8),
          dropPct: dropPct.toFixed(2) + '%',
          buyPressure: ((pair.txns5m_buys / (pair.txns5m_buys + pair.txns5m_sells || 1)) * 100).toFixed(0) + '%',
        });

        GraduatedStore.updateTradeTracking(mint, {
          entrySignalPrice: pair.priceUsd,
          entrySignalAt: Date.now(),
        });

        this.emit('entrySignal', state.token, pair, {
          listingPrice: state.listingPrice,
          currentPrice: pair.priceUsd,
          dropPct,
          ath: state.ath,
          buyPressure: pair.txns5m_buys,
          sellPressure: pair.txns5m_sells,
          vol5m: pair.vol5m,
          liquidityUsd: pair.liquidityUsd,
          dexUrl: pair.url,
        });
      }

    } catch (err) {
      log.error(`Poll error for ${state.token.symbol}`, { err: err.message });
    }
  }

  stopTracking(mint, reason = 'manual') {
    const state = this.watching.get(mint);
    if (!state) return;

    if (state.interval) clearInterval(state.interval);
    this.watching.delete(mint);

    log.info(`Stopped tracking ${state.token.symbol}`, {
      reason,
      pollCount: state.pollCount,
      trackingMinutes: ((Date.now() - state.startedAt) / 60000).toFixed(1),
    });
  }

  get watchCount() { return this.watching.size; }
}

export const graduationTracker = new GraduationTracker();