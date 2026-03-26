// ─────────────────────────────────────────────
//  index.js  —  pump-scanner main entry
//  Boot order:
//    1. Connect Discord bot
//    2. Init QuickNode WS pool
//    3. Connect PumpPortal feed
//    4. Wire all event handlers
//    5. Start registry loops (score, cleanup)
//    6. Start stats reporter
// ─────────────────────────────────────────────

// Load .env FIRST — before any other import reads process.env
import 'dotenv/config';

import { CONFIG } from './config.js';
import createLogger from './utils/logger.js';
import { connectDiscord, discordBot, sendSignal, sendGraduation, updateGraduation, sendEntrySignal, sendStats, sendKOLConvergenceAlert, sendKOLHolderAlert, sendStrategyReport } from './alerts/discord.js';
import { pumpFeed } from './feeds/pumpportal.js';
import { qnWSPool } from './feeds/quicknode.js';
import { registry } from './analysis/registry.js';
import { graduationTracker } from './analysis/graduationTracker.js';
import { GraduatedStore, writeStatsFile } from './storage/storage.js';
import { kolTracker } from './enrichment/kolWallets.js';
import { kolConvergence } from './analysis/kolConvergence.js';
import { lifecycleTracker } from './analysis/tokenLifecycle.js';
import { startAnalysisScheduler, formatAnalysisForDiscord } from './analysis/strategyAnalyzer.js';

const log = createLogger('MAIN');

// ─────────────────────────────────────────────
//  Boot sequence
// ─────────────────────────────────────────────

async function boot() {
  log.section('pump-scanner booting');
  log.info('Node version:', { version: process.version });
  log.info('Config loaded', {
    logLevel:         CONFIG.LOG_LEVEL,
    signalMin:        CONFIG.SIGNAL_SCORE_MIN,
    tradeAlertMin:    CONFIG.TRADE_ALERT_SCORE_MIN,
    maxActiveTokens:  CONFIG.MAX_ACTIVE_TOKENS,
    dumpEntryDrop:    CONFIG.DUMP_ENTRY_DROP_PCT + '%',
  });

  // 1. Discord
  log.section('Step 1: Discord Bot');
  await connectDiscord();
  await waitForDiscord();

  // 2. KOL Wallets
  log.section('Step 2: KOL Wallet Tracker');
  kolTracker.load();
  kolTracker.watch();
  log.info(`KOL wallets ready: ${kolTracker.count} wallets loaded`);

  // 3. QuickNode WS Pool
  log.section('Step 3: QuickNode WebSocket Pool');
  await qnWSPool.init();

  // 4. PumpPortal
  log.section('Step 4: PumpPortal Feed');
  pumpFeed.connect();

  // Subscribe KOL wallets to account trade stream once PumpPortal connects
  pumpFeed.once('connected', () => {
    if (kolTracker.count > 0) {
      log.info(`Subscribing ${kolTracker.count} KOL wallets to PumpPortal account trade stream...`);
      kolTracker.subscribeAllToFeed(pumpFeed);
    }
  });

  // 5. Wire events
  log.section('Step 5: Wiring Event Handlers');
  wireEvents();

  // 6. Start loops
  log.section('Step 6: Starting Registry Loops');
  registry.startScoreLoop();
  registry.startCleanupLoop();

  // 6. Stats reporter
  log.section('Step 6: Stats Reporter');
  startStatsReporter();

  log.section('🚀 pump-scanner LIVE');
  log.info(`Monitoring pump.fun — watching for bonding candidates`, {
    scoreThreshold:      CONFIG.SIGNAL_SCORE_MIN,
    tradeAlertThreshold: CONFIG.TRADE_ALERT_SCORE_MIN,
    dumpEntryRange:      `${CONFIG.DUMP_ENTRY_DROP_PCT}% — ${CONFIG.DUMP_ENTRY_MAX_DROP}%`,
  });
}

function waitForDiscord() {
  return new Promise((resolve) => {
    if (discordBot.isReady()) { resolve(); return; }
    // If token wasn't set, bot will never emit ready — resolve immediately after short wait
    discordBot.once('ready', resolve);
    setTimeout(resolve, 8000); // don't block boot more than 8s waiting for Discord
  });
}

// ─────────────────────────────────────────────
//  Event wiring
// ─────────────────────────────────────────────

function wireEvents() {

  // ── PumpPortal → Registry ───────────────────
  // No newToken subscription — we only act on migrations.
  // Trade handler lives further down (handles KOL detection + registry update).

  pumpFeed.on('graduated', (gradData) => {
    log.info(`🎓 Graduation event received from feed: ${gradData.mint?.slice(0, 8)}...`);
    registry.onGraduation(gradData);
  });

  // ── Registry → PumpPortal subscriptions ─────

  registry.on('startTracking', (token) => {
    pumpFeed.subscribeToToken(token.mint);
  });

  // ── Registry → Discord alerts ────────────────

  registry.on('stageChange', (token, prevStage, newStage) => {
    log.info(`Stage change event: ${token.symbol} ${prevStage}→${newStage}`);
  });

  registry.on('alert', (token, signal) => {
    const serialized = {
      ...token,
      uniqueBuyers:  token.uniqueBuyers instanceof Set ? token.uniqueBuyers.size : token.uniqueBuyers,
      uniqueSellers: token.uniqueSellers instanceof Set ? token.uniqueSellers.size : token.uniqueSellers,
    };
    sendSignal(serialized, signal);
  });

  registry.on('graduated', (token, gradData) => {
    const serialized = {
      ...token,
      uniqueBuyers:  token.uniqueBuyers instanceof Set ? token.uniqueBuyers.size : token.uniqueBuyers,
      uniqueSellers: token.uniqueSellers instanceof Set ? token.uniqueSellers.size : token.uniqueSellers,
    };

    // Quick Mayhem pre-check from pump.fun API before sending any embeds
    // We fetch asynchronously — if MCap < $6K we skip everything
    fetch(`https://frontend-api.pump.fun/coins/${token.mint}`, {
      signal: AbortSignal.timeout(4000),
    }).then(r => r.ok ? r.json() : null).then(pumpData => {
      const mcapUsd = pumpData?.usd_market_cap || null;
      if (mcapUsd !== null && mcapUsd < 6000) {
        log.warn(`🗑 MAYHEM TOKEN — skipping entirely: ${serialized.symbol} MCap $${mcapUsd.toFixed(0)}`, {
          mint: token.mint.slice(0, 8),
        });
        return; // Don't send embed, don't start tracking
      }
      // Normal graduation flow
      sendGraduation(serialized);
      graduationTracker.startTracking(serialized);
    }).catch(() => {
      // pump.fun API failed — proceed normally, graduationTracker will catch it
      sendGraduation(serialized);
      graduationTracker.startTracking(serialized);
    });
  });

  registry.on('enriched', (token, filterResult) => {
    log.info(`Enrichment complete for ${token.symbol}`, { pass: filterResult.pass });

    const serialized = {
      ...token,
      uniqueBuyers:  token.uniqueBuyers instanceof Set ? token.uniqueBuyers.size : token.uniqueBuyers,
      uniqueSellers: token.uniqueSellers instanceof Set ? token.uniqueSellers.size : token.uniqueSellers,
    };

    // 3. Start lifecycle tracking with full enrichment context
    lifecycleTracker.startTracking(
      serialized,
      token.holderSnapshot,
      token.bundleResult,
      filterResult
    );

    // Fire KOL holder alert if any KOL wallets found in holder list
    const kolMatches = token.holderSnapshot?.kolMatches || [];
    if (kolMatches.length > 0) {
      const tsKOL = graduationTracker.watching?.get(token.mint);
      sendKOLHolderAlert(kolMatches, serialized, tsKOL?.lastPair || null);
    }

    // Edit the graduation embed with real filter/holder/bundle data
    const trackerState = graduationTracker.watching?.get(token.mint);
    const currentPair  = trackerState?.lastPair || null;
    updateGraduation(serialized, currentPair, true);
  });

  // ── KOL live trade events ────────────────────
  pumpFeed.on('trade', (tradeData) => {
    const kolName = kolTracker.getName(tradeData.trader);
    if (kolName) {
      log.info(`KOL ${tradeData.type}: ${kolName} ${tradeData.solAmount?.toFixed(3)} SOL`, {
        mint:    tradeData.mint.slice(0, 8) + '...',
        bonding: tradeData.bondingPct?.toFixed(1) + '%',
      });

      // Record KOL activity in lifecycle tracker
      const lcState = lifecycleTracker.tracking?.get(tradeData.mint);
      if (lcState) {
        lifecycleTracker.recordKOLTrade(
          tradeData.mint, kolName, tradeData.type,
          tradeData.solAmount, tradeData.marketCapSol
        );
      }

      if (tradeData.type === 'buy') {
        const conv = kolConvergence.recordBuy(kolName, tradeData.trader, tradeData);
        if (conv) {
          const tokenName = kolConvergence.getTokenName(tradeData.mint)
            || graduationTracker.watching?.get(tradeData.mint)?.token?.name
            || null;
          sendKOLConvergenceAlert(conv, tokenName);
        }
      }
    }
    registry.onTrade(tradeData);
  });

  // ── GraduationTracker events ─────────────────

  graduationTracker.on('listed', (token, pair, listingPrice) => {
    log.info(`📋 Listed on DEX: ${token.symbol}`, {
      listingPrice: listingPrice.toFixed(8),
      dex: pair.dex,
      liqUsd: pair.liquidityUsd.toFixed(0),
    });

    // Feed real name + listing data to lifecycle tracker
    const realName = pair.baseTokenName || token.symbol;
    kolConvergence.setTokenName(token.mint, realName);
    lifecycleTracker.setListing(token.mint, pair);

    const registryToken = registry.getToken(token.mint);
    const enrichmentDone = registry.enriched?.has(token.mint) || !!registryToken?.filterResult;
    const fullToken = registryToken ? {
      ...registryToken,
      uniqueBuyers:  registryToken.uniqueBuyers instanceof Set ? registryToken.uniqueBuyers.size : registryToken.uniqueBuyers,
      uniqueSellers: registryToken.uniqueSellers instanceof Set ? registryToken.uniqueSellers.size : registryToken.uniqueSellers,
    } : token;
    updateGraduation(fullToken, pair, enrichmentDone);
  });

  graduationTracker.on('stateChange', (token, tradeState, pair) => {
    log.info(`Trade state → ${tradeState}: ${token.symbol}`, {
      price: pair.priceUsd.toFixed(8),
    });
  });

  graduationTracker.on('entrySignal', (token, pair, dumpData) => {
    // Hard block — never fire entry signals for Mayhem / near-zero MCap tokens
    const mcapUsd = pair.mcap || pair.fdv || dumpData.liquidityUsd * 2 || 0;
    if (mcapUsd > 0 && mcapUsd < 6000) {
      log.warn(`🗑 Suppressed entry signal — Mayhem token: ${token.symbol} MCap $${mcapUsd.toFixed(0)}`);
      return;
    }
    // Also block if liquidity is under $500 — not tradeable
    if (dumpData.liquidityUsd < 500) {
      log.warn(`🗑 Suppressed entry signal — too low liquidity: ${token.symbol} $${dumpData.liquidityUsd.toFixed(0)}`);
      return;
    }
    log.info(`🎯 Entry signal wired → Discord for ${token.symbol}`);
    sendEntrySignal(token, pair, dumpData);
  });

  log.info('All event handlers wired ✅');
}

// ─────────────────────────────────────────────
//  Stats reporter
// ─────────────────────────────────────────────

function startStatsReporter() {
  // Log stats to console + #logs channel every 5 minutes
  setInterval(() => {
    const regStats = registry.getStats();
    const feedStats = pumpFeed.getStats();
    const graduatedCount = GraduatedStore.count();

    log.section('=== STATS REPORT ===');
    log.info('Registry stats', regStats);
    log.info('Feed stats', feedStats);
    log.info('Graduated store count', { count: graduatedCount });
    log.info('Graduation tracker watching', { count: graduationTracker.watchCount });
    log.info('Lifecycle tracker active', { count: lifecycleTracker.activeCount });

    writeStatsFile({
      registry: regStats,
      feed: feedStats,
      graduatedCount,
      graduationWatching: graduationTracker.watchCount,
      lifecycleActive: lifecycleTracker.activeCount,
      qnWsSubscriptions: qnWSPool.activeSubscriptions,
    });

    sendStats(regStats, feedStats, graduatedCount);

  }, 5 * 60 * 1000);

  // Strategy analysis runs every 6h (after first 5 min of data)
  startAnalysisScheduler((analysis) => {
    const report = formatAnalysisForDiscord(analysis);
    if (report) sendStrategyReport(report);
  });

  log.info('Stats reporter + strategy scheduler started');
}

// ─────────────────────────────────────────────
//  Global error handlers
// ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  log.error('💥 UNCAUGHT EXCEPTION', { err: err.message, stack: err.stack });
  // Don't exit — let PM2 handle restart if truly unrecoverable
});

process.on('unhandledRejection', (reason) => {
  log.error('💥 UNHANDLED REJECTION', { reason: String(reason) });
});

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────

boot().catch((err) => {
  log.error('Boot failed', { err: err.message, stack: err.stack });
  process.exit(1);
});