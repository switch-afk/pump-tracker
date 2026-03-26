// ─────────────────────────────────────────────
//  analysis/tokenLifecycle.js
//  Exhaustive token lifecycle tracker
//
//  Records EVERYTHING about every graduated token:
//  - Price snapshots every 30s for 2 hours
//  - Volume, liquidity, buy/sell pressure over time
//  - Holder evolution (snapshot at T+0, T+5m, T+15m, T+30m, T+60m)
//  - KOL presence at graduation and over time
//  - Pre-graduation signals (bonding speed, bundle, concentration)
//  - Outcome classification (DUMPED / ATH_BREAK / MOON)
//  - All data written to data/lifecycle/{mint}.json
//
//  This dataset is used to:
//  1. Identify which pre-graduation signals predict ATH breaks
//  2. Auto-tune filter thresholds based on win rates
//  3. Build a scoring model grounded in real outcomes
// ─────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { getBestPair } from '../enrichment/dexscreener.js';
import { takeHolderSnapshot } from '../enrichment/holderAnalysis.js';
import createLogger from '../utils/logger.js';

const log = createLogger('LIFECYCLE');

const LIFECYCLE_DIR = path.join(CONFIG.DATA_DIR, 'lifecycle');
if (!fs.existsSync(LIFECYCLE_DIR)) fs.mkdirSync(LIFECYCLE_DIR, { recursive: true });

// ── Snapshot schedule post-graduation (minutes) ──
// Dense early coverage, sparse late
const HOLDER_SNAPSHOT_SCHEDULE = [0, 5, 15, 30, 60];  // minutes post-listing
const PRICE_POLL_INTERVAL_MS   = 30_000;               // 30s
const TRACK_DURATION_MS        = 2 * 60 * 60_000;      // 2 hours

// ── Outcome thresholds ────────────────────────
const ATH_BREAK_MULTIPLIER = 1.2;   // price > listing * 1.2 = ATH_BREAK
const MOON_MULTIPLIER      = 2.0;   // price > listing * 2.0 = MOON
const DUMP_THRESHOLD       = 0.5;   // price < listing * 0.5 = DUMPED

class TokenLifecycleTracker {
  constructor() {
    // mint → lifecycle state
    this.tracking = new Map();
    log.info(`Lifecycle tracker initialized`, { dir: LIFECYCLE_DIR });
  }

  // ── Start tracking a graduated token ──────────

  startTracking(token, holderSnapshot, bundleResult, filterResult) {
    if (this.tracking.has(token.mint)) return;

    log.info(`📸 Starting lifecycle track: [${token.symbol}] ${token.mint.slice(0, 8)}...`);

    const lifecycle = {
      // ── Identity ──
      mint:           token.mint,
      name:           token.name || 'Unknown',
      symbol:         token.symbol,
      pool:           token.pool || null,
      graduatedAt:    Date.now(),

      // ── Pre-graduation signals ──────────────
      // These are the inputs we want to correlate with outcomes
      preGrad: {
        bondingPct:       100,
        // Will be filled when graduation data is available
        kolsInHolders:    holderSnapshot?.kolMatches?.length || 0,
        kolNames:         holderSnapshot?.kolMatches?.map(k => k.name) || [],
        holderCount:      holderSnapshot?.holderCount || 0,
        devPct:           holderSnapshot?.devPct || 0,
        top3Pct:          holderSnapshot?.top3Pct || 0,
        top10Pct:         holderSnapshot?.top10Pct || 0,
        holderScore:      holderSnapshot?.holderScore || 0,
        isBundle:         bundleResult?.isBundle || false,
        bundleConfidence: bundleResult?.confidence || 0,
        filterPassed:     filterResult?.pass || false,
        filterReasons:    filterResult?.reasons || [],
      },

      // ── DEX listing data ────────────────────
      listing: {
        price:        null,
        liquidityUsd: null,
        dex:          null,
        listedAt:     null,
        listedAtMins: null,  // minutes after graduation
      },

      // ── Price time-series ───────────────────
      // Array of { t, price, vol5m, liqUsd, buys5m, sells5m, mcapUsd }
      // t = seconds since listing (0 = listing price)
      priceSeries: [],

      // ── Holder snapshots at key intervals ──
      // { t0, t5, t15, t30, t60 } — taken at minutes post-listing
      holderSeries: {},
      holderSnapshotsDone: [],

      // ── ATH tracking ───────────────────────
      ath:               null,
      athAt:             null,       // seconds since listing
      athMultiplier:     null,       // ath / listingPrice
      lowestPrice:       null,
      maxDrawdownPct:    null,

      // ── Outcome (computed at end of tracking window) ──
      // MOON | ATH_BREAK | RECOVERING | DUMPED | OVER_DUMPED | UNKNOWN
      outcome:            'UNKNOWN',
      outcomeMultiplier:  null,      // finalPrice / listingPrice
      finalPrice:         null,
      finalAt:            null,

      // ── KOL activity during tracking window ─
      kolActivity: [],  // { kolName, action, solAmount, priceAtTrade, t }

      // ── Misc ────────────────────────────────
      pollCount:          0,
      trackingComplete:   false,
    };

    this.tracking.set(token.mint, lifecycle);

    // Try to get listing data immediately from pump.fun if DEX not up yet
    this._initListingFromPumpFun(token.mint);

    // Schedule price polling — starts immediately, uses pump.fun fallback until DEX is live
    const interval = setInterval(() => this._pricePoll(token.mint), PRICE_POLL_INTERVAL_MS);
    lifecycle._interval = interval;

    // Schedule holder snapshots
    this._scheduleHolderSnapshots(token);

    // Auto-complete after TRACK_DURATION_MS
    setTimeout(() => this._complete(token.mint), TRACK_DURATION_MS);

    // Save initial skeleton
    this._save(lifecycle);
  }

  // ── Try to set listing data from pump.fun API immediately ─

  async _initListingFromPumpFun(mint) {
    // Small delay — let DexScreener have first shot
    await sleep(3000);
    const lc = this.tracking.get(mint);
    if (!lc || lc.listing.price) return; // already set by DEX

    try {
      const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json();

      // Update name/symbol from pump.fun
      if (data.name && lc.name === 'Unknown') lc.name = data.name;
      if (data.symbol) lc.symbol = data.symbol;

      log.debug(`pump.fun meta fetched for lifecycle: [${lc.symbol}] ${lc.name}`);
    } catch { /* non-fatal */ }
  }

  // ── Record DEX listing ─────────────────────

  setListing(mint, pair) {
    const lc = this.tracking.get(mint);
    if (!lc || lc.listing.price) return;  // already set

    const minsAfterGrad = (Date.now() - lc.graduatedAt) / 60000;

    lc.listing = {
      price:        pair.priceUsd,
      liquidityUsd: pair.liquidityUsd,
      dex:          pair.dex,
      fdv:          pair.fdv || null,
      listedAt:     Date.now(),
      listedAtMins: parseFloat(minsAfterGrad.toFixed(2)),
    };
    lc.ath        = pair.priceUsd;
    lc.athAt      = 0;
    lc.lowestPrice = pair.priceUsd;

    log.info(`📋 Lifecycle listing recorded: [${lc.symbol}]`, {
      price:   pair.priceUsd.toFixed(8),
      liqUsd:  pair.liquidityUsd.toFixed(0),
      minsAfterGrad: minsAfterGrad.toFixed(1),
    });

    // First price snapshot at T=0
    lc.priceSeries.push(this._buildSnapshot(0, pair));
    this._save(lc);
  }

  // ── Record KOL trade during tracking window ─

  recordKOLTrade(mint, kolName, action, solAmount, currentPrice) {
    const lc = this.tracking.get(mint);
    if (!lc || !lc.listing.price) return;

    const t = (Date.now() - lc.listing.listedAt) / 1000;
    lc.kolActivity.push({ kolName, action, solAmount, price: currentPrice, t: Math.round(t) });
    log.debug(`KOL activity recorded for lifecycle: ${kolName} ${action} on ${lc.symbol}`);
    // Don't save on every trade — save will happen on next price poll
  }

  // ── Price polling ──────────────────────────

  async _pricePoll(mint) {
    const lc = this.tracking.get(mint);
    if (!lc || !lc.listing.listedAt) return;

    lc.pollCount++;
    const t = Math.round((Date.now() - lc.listing.listedAt) / 1000);

    try {
      // Try DexScreener first (live DEX data)
      let pair = await getBestPair(mint);

      // Fallback: if no DEX pair yet, fetch from pump.fun API
      if (!pair || pair.priceUsd === 0) {
        try {
          const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.usd_market_cap && data.market_cap) {
              pair = {
                priceUsd:      data.usd_market_cap / 1_000_000_000, // approx from mcap
                vol5m:         0,
                liquidityUsd:  0,
                txns5m_buys:   0,
                txns5m_sells:  0,
                priceChange5m: 0,
                priceChange1h: 0,
                fdv:           data.usd_market_cap || 0,
                dex:           'pump.fun',
                url:           `https://pump.fun/${mint}`,
                _fromPumpFun:  true,
              };
            }
          }
        } catch { /* ignore pump.fun fallback errors */ }
      }

      if (!pair || pair.priceUsd === 0) return;

      lc.priceSeries.push(this._buildSnapshot(t, pair));

      // ATH tracking
      if (pair.priceUsd > lc.ath) {
        lc.ath = pair.priceUsd;
        lc.athAt = t;
        lc.athMultiplier = parseFloat((lc.ath / lc.listing.price).toFixed(4));
        log.info(`📈 Lifecycle ATH: [${lc.symbol}] x${lc.athMultiplier} at T+${Math.round(t/60)}m`);
      }

      // Lowest tracking
      if (pair.priceUsd < lc.lowestPrice) {
        lc.lowestPrice = pair.priceUsd;
        lc.maxDrawdownPct = parseFloat(
          (((lc.listing.price - lc.lowestPrice) / lc.listing.price) * 100).toFixed(2)
        );
      }

      this._save(lc);

    } catch (err) {
      log.error(`Lifecycle price poll error: ${lc.symbol}`, { err: err.message });
    }
  }

  // ── Holder snapshots at T+0, T+5m, T+15m, T+30m, T+60m ──

  _scheduleHolderSnapshots(token) {
    for (const mins of HOLDER_SNAPSHOT_SCHEDULE) {
      // T+0 is handled in setListing → enrich data already captured at graduation
      // We do T+5, T+15, T+30, T+60 post-listing
      if (mins === 0) continue;

      setTimeout(async () => {
        const lc = this.tracking.get(token.mint);
        if (!lc || !lc.listing.listedAt) return;

        try {
          log.info(`📸 Taking T+${mins}m holder snapshot: [${lc.symbol}]`);
          const snap = await takeHolderSnapshot(token.mint, token.creator);
          if (snap) {
            lc.holderSeries[`t${mins}`] = {
              takenAtMins: mins,
              holderCount: snap.holderCount,
              devPct:      snap.devPct,
              top3Pct:     snap.top3Pct,
              top10Pct:    snap.top10Pct,
              holderScore: snap.holderScore,
              kolMatches:  snap.kolMatches?.map(k => k.name) || [],
            };
            lc.holderSnapshotsDone.push(mins);
            log.info(`✅ T+${mins}m snapshot done: [${lc.symbol}]`, {
              holders: snap.holderCount,
              top3:    snap.top3Pct + '%',
            });
            this._save(lc);
          }
        } catch (err) {
          log.error(`Holder snapshot T+${mins}m failed: ${lc.symbol}`, { err: err.message });
        }
      }, mins * 60_000);
    }
  }

  // ── Complete lifecycle tracking ────────────

  _complete(mint) {
    const lc = this.tracking.get(mint);
    if (!lc) return;

    if (lc._interval) clearInterval(lc._interval);

    // Classify outcome
    if (lc.listing.price && lc.ath) {
      lc.athMultiplier     = parseFloat((lc.ath / lc.listing.price).toFixed(4));
      const finalSnap      = lc.priceSeries[lc.priceSeries.length - 1];
      lc.finalPrice        = finalSnap?.price || lc.ath;
      lc.outcomeMultiplier = parseFloat((lc.finalPrice / lc.listing.price).toFixed(4));
      lc.finalAt           = finalSnap?.t || null;

      if (lc.athMultiplier >= MOON_MULTIPLIER) {
        lc.outcome = 'MOON';
      } else if (lc.athMultiplier >= ATH_BREAK_MULTIPLIER) {
        lc.outcome = 'ATH_BREAK';
      } else if (lc.outcomeMultiplier >= 0.8) {
        lc.outcome = 'RECOVERING';
      } else if (lc.outcomeMultiplier >= DUMP_THRESHOLD) {
        lc.outcome = 'DUMPED';
      } else {
        lc.outcome = 'OVER_DUMPED';
      }
    }

    lc.trackingComplete = true;

    log.info(`🏁 Lifecycle complete: [${lc.symbol}] outcome=${lc.outcome}`, {
      athMultiplier:     lc.athMultiplier,
      outcomeMultiplier: lc.outcomeMultiplier,
      maxDrawdownPct:    lc.maxDrawdownPct,
      pollCount:         lc.pollCount,
      kolActivity:       lc.kolActivity.length,
      holderSnaps:       lc.holderSnapshotsDone.join(', '),
    });

    this._save(lc);
    this.tracking.delete(mint);

    // Append to summary index
    this._appendToIndex(lc);
  }

  // ── Helpers ────────────────────────────────

  _buildSnapshot(t, pair) {
    return {
      t,
      price:     pair.priceUsd,
      vol5m:     pair.vol5m,
      liqUsd:    pair.liquidityUsd,
      buys5m:    pair.txns5m_buys,
      sells5m:   pair.txns5m_sells,
      buyPct:    pair.txns5m_buys + pair.txns5m_sells > 0
        ? parseFloat(((pair.txns5m_buys / (pair.txns5m_buys + pair.txns5m_sells)) * 100).toFixed(1))
        : 50,
      priceChange5m: pair.priceChange5m || 0,
      priceChange1h: pair.priceChange1h || 0,
      fdv:       pair.fdv || 0,
    };
  }

  _save(lc) {
    const filePath = path.join(LIFECYCLE_DIR, `${lc.mint}.json`);
    try {
      // Don't serialize the interval
      const { _interval, ...data } = lc;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      log.error(`Failed to save lifecycle: ${lc.symbol}`, { err: err.message });
    }
  }

  // Append a one-line summary to lifecycle-index.json for fast querying
  _appendToIndex(lc) {
    const indexPath = path.join(LIFECYCLE_DIR, 'index.json');
    let index = [];
    try {
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      }
    } catch { /* start fresh */ }

    // Remove existing entry for this mint (in case of restart)
    index = index.filter(e => e.mint !== lc.mint);

    index.push({
      mint:              lc.mint,
      name:              lc.name,
      symbol:            lc.symbol,
      graduatedAt:       lc.graduatedAt,
      pool:              lc.pool,
      outcome:           lc.outcome,
      athMultiplier:     lc.athMultiplier,
      outcomeMultiplier: lc.outcomeMultiplier,
      maxDrawdownPct:    lc.maxDrawdownPct,
      listingPrice:      lc.listing.price,
      listingLiqUsd:     lc.listing.liquidityUsd,
      listedAtMins:      lc.listing.listedAtMins,
      // Pre-grad signals
      holderCount:       lc.preGrad.holderCount,
      devPct:            lc.preGrad.devPct,
      top3Pct:           lc.preGrad.top3Pct,
      holderScore:       lc.preGrad.holderScore,
      isBundle:          lc.preGrad.isBundle,
      filterPassed:      lc.preGrad.filterPassed,
      kolsAtGrad:        lc.preGrad.kolsInHolders,
      kolNames:          lc.preGrad.kolNames,
      kolActivityCount:  lc.kolActivity.length,
      pollCount:         lc.pollCount,
    });

    // Keep last 1000 entries
    if (index.length > 1000) index = index.slice(-1000);

    try {
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      log.info(`Index updated: ${index.length} lifecycle entries total`);
    } catch (err) {
      log.error('Failed to write lifecycle index', { err: err.message });
    }
  }

  get activeCount() { return this.tracking.size; }
}

export const lifecycleTracker = new TokenLifecycleTracker();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }