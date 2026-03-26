// ─────────────────────────────────────────────
//  analysis/kolConvergence.js
//  KOL Convergence Tracker
//
//  Logic:
//  - Buffer every KOL trade per mint
//  - Alert ONLY when 2+ UNIQUE KOLs bought the same mint
//    within the last KOL_WINDOW_MS (default 10 min)
//  - Each mint gets ONE alert per convergence event
//    (re-alerts if a new KOL joins after cooldown)
//  - Ignore sells for convergence detection (buys only)
//  - Ignore tiny buys < MIN_SOL_AMOUNT
// ─────────────────────────────────────────────

import createLogger from '../utils/logger.js';

const log = createLogger('KOL-CONV');

const KOL_WINDOW_MS   = 10 * 60 * 1000;  // 10 minute window
const MIN_KOL_COUNT   = 2;                // min unique KOLs to trigger alert
const MIN_SOL_AMOUNT  = 0.05;             // ignore dust buys < 0.05 SOL
const ALERT_COOLDOWN  = 5 * 60 * 1000;   // don't re-alert same mint within 5 min

class KOLConvergenceTracker {
  constructor() {
    // mint → [{ kolName, kolAddress, solAmount, mcapSol, bondingPct, ts }]
    this.buys = new Map();
    // mint → last alert ts (to prevent spam)
    this.lastAlert = new Map();
    // mint → token name (populated when known)
    this.tokenNames = new Map();
    // Cleanup stale entries every 5 min
    setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  // Store a token name when we learn it
  setTokenName(mint, name) {
    if (name && name !== 'Unknown') {
      this.tokenNames.set(mint, name);
    }
  }

  getTokenName(mint) {
    return this.tokenNames.get(mint) || null;
  }

  /**
   * Record a KOL buy.
   * Returns convergence data if threshold is met, null otherwise.
   */
  recordBuy(kolName, kolAddress, tradeData) {
    if (tradeData.type !== 'buy') return null;
    if ((tradeData.solAmount || 0) < MIN_SOL_AMOUNT) return null;

    const { mint } = tradeData;
    const now = Date.now();

    if (!this.buys.has(mint)) this.buys.set(mint, []);

    const buyList = this.buys.get(mint);

    // Add this buy
    buyList.push({
      kolName,
      kolAddress,
      solAmount:  tradeData.solAmount || 0,
      mcapSol:    tradeData.marketCapSol || 0,
      bondingPct: tradeData.bondingPct || 0,
      ts:         now,
    });

    // Filter to only buys within the window
    const recent = buyList.filter(b => now - b.ts <= KOL_WINDOW_MS);
    this.buys.set(mint, recent);

    // Count unique KOL buyers in window
    const uniqueKOLs = [...new Map(recent.map(b => [b.kolName, b])).values()];

    log.debug(`KOL buy recorded: ${kolName} on ${mint.slice(0,8)}... (${uniqueKOLs.length} unique KOLs in window)`);

    if (uniqueKOLs.length < MIN_KOL_COUNT) return null;

    // Check cooldown
    const lastAlertTs = this.lastAlert.get(mint) || 0;
    if (now - lastAlertTs < ALERT_COOLDOWN) {
      log.debug(`KOL convergence cooldown active for ${mint.slice(0,8)}... (${((ALERT_COOLDOWN - (now - lastAlertTs))/1000).toFixed(0)}s remaining)`);
      return null;
    }

    // Set cooldown
    this.lastAlert.set(mint, now);

    // Build convergence summary
    const totalSol = recent.reduce((sum, b) => sum + b.solAmount, 0);
    const latestMcap = recent[recent.length - 1].mcapSol;
    const latestBonding = recent[recent.length - 1].bondingPct;

    const convergence = {
      mint,
      uniqueKOLs,
      totalSol,
      mcapSol:    latestMcap,
      bondingPct: latestBonding,
      windowMins: KOL_WINDOW_MS / 60000,
      ts:         now,
    };

    log.info(`🎯 KOL CONVERGENCE: ${uniqueKOLs.length} KOLs on ${mint.slice(0,8)}...`, {
      kols:       uniqueKOLs.map(k => k.kolName).join(', '),
      totalSol:   totalSol.toFixed(3),
      bonding:    latestBonding.toFixed(1) + '%',
      mcapSol:    latestMcap.toFixed(2),
    });

    return convergence;
  }

  _cleanup() {
    const now = Date.now();
    for (const [mint, buys] of this.buys) {
      const fresh = buys.filter(b => now - b.ts <= KOL_WINDOW_MS);
      if (fresh.length === 0) {
        this.buys.delete(mint);
        this.lastAlert.delete(mint);
      } else {
        this.buys.set(mint, fresh);
      }
    }
    log.debug(`KOL convergence cleanup: ${this.buys.size} active mints tracked`);
  }

  getActiveMints() { return this.buys.size; }
}

export const kolConvergence = new KOLConvergenceTracker();