// ─────────────────────────────────────────────
//  enrichment/holderAnalysis.js
//  - Top holder snapshot from QuickNode RPC
//  - Dev wallet % calculation
//  - Bundle detection via fee-payer clustering per slot
//  - KOL wallet detection in holder list
//  - Filter application
// ─────────────────────────────────────────────

import { getTokenLargestAccounts, getSignatures, getParsedTransaction, getTokenSupply } from '../feeds/quicknode.js';
import { kolTracker } from './kolWallets.js';
import createLogger from '../utils/logger.js';
import { CONFIG } from '../config.js';

const log = createLogger('HOLDER-ANALYSIS');

// ── Holder Snapshot ────────────────────────────

export async function takeHolderSnapshot(mint, devWallet) {
  log.info(`Taking holder snapshot for ${mint.slice(0, 8)}...`, {
    devWallet: devWallet ? devWallet.slice(0, 8) + '...' : 'unknown',
  });

  const [largestAccounts, totalSupply] = await Promise.all([
    getTokenLargestAccounts(mint),
    getTokenSupply(mint),
  ]);

  if (!largestAccounts.length) {
    log.warn(`No holder data available for ${mint.slice(0, 8)}...`);
    return null;
  }

  const totalAmount = totalSupply > 0
    ? totalSupply
    : largestAccounts.reduce((sum, a) => sum + a.amount, 0) || 1;

  const holders = largestAccounts.map(a => ({
    address: a.address,
    amount: a.amount,
    pct: parseFloat(((a.amount / totalAmount) * 100).toFixed(2)),
    isDev: devWallet ? a.address === devWallet : false,
  }));

  holders.sort((a, b) => b.pct - a.pct);

  const devHolder = holders.find(h => h.isDev);
  const devPct    = devHolder?.pct || 0;
  const top3Pct   = holders.slice(0, 3).reduce((sum, h) => sum + h.pct, 0);
  const top10Pct  = holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);

  // Holder score: start 100, penalize concentration + dev holding
  let holderScore = 100;
  if (top3Pct > 15)  holderScore -= Math.min(50, (top3Pct - 15) * 2);
  if (top10Pct > 30) holderScore -= Math.min(30, (top10Pct - 30) * 1);
  if (devPct > 0)    holderScore -= Math.min(40, devPct * 3);
  holderScore = Math.max(0, Math.round(holderScore));

  // KOL check across all holder addresses
  const kolMatches = kolTracker.checkAllHolderAddresses(holders.map(h => h.address), mint);

  const snapshot = {
    mint,
    takenAt:     Date.now(),
    holderCount: largestAccounts.length,
    devPct:      parseFloat(devPct.toFixed(2)),
    top3Pct:     parseFloat(top3Pct.toFixed(2)),
    top10Pct:    parseFloat(top10Pct.toFixed(2)),
    holderScore,
    topHolders:  holders.slice(0, 10),
    kolMatches,
  };

  log.info(`Holder snapshot complete for ${mint.slice(0, 8)}...`, {
    holders:     snapshot.holderCount,
    devPct:      snapshot.devPct + '%',
    top3Pct:     snapshot.top3Pct + '%',
    holderScore: snapshot.holderScore,
    kolsFound:   kolMatches.length,
  });

  return snapshot;
}

// ── Bundle Detection ────────────────────────────
//
// A REAL bundle = multiple DIFFERENT fee-payer wallets buying
// the same token in the same block slot (coordinated Jito bundle or multi-wallet launch).
//
// Previous bug: we were grabbing ALL accountKeys from a transaction
// (fee payer + program accounts + token accounts = 10-15 accounts per tx)
// and treating any slot with 3+ addresses as a bundle. This flagged
// almost every token as bundled.
//
// Correct logic:
//   1. For each tx, extract ONLY the fee payer (accountKeys[0], signer+writable)
//   2. Only count transactions that are actual buys (SOL spent + token received)
//   3. Group fee payers by slot — if 3+ DIFFERENT wallets bought in same slot = bundle

export async function detectBundle(mint) {
  log.info(`Running bundle check for ${mint.slice(0, 8)}...`);

  const signatures = await getSignatures(mint, 50);
  if (!signatures.length) {
    log.warn(`No signatures found for bundle check: ${mint.slice(0, 8)}...`);
    return { isBundle: false, confidence: 0, bundleWallets: [], bundleSlots: [] };
  }

  const txBatch   = signatures.slice(0, 30);
  const txResults = [];

  for (const sig of txBatch) {
    const tx = await getParsedTransaction(sig.signature);
    if (tx) txResults.push({ sig: sig.signature, slot: sig.slot, tx });
    await sleep(80);
  }

  if (txResults.length === 0) {
    return { isBundle: false, confidence: 0, bundleWallets: [], bundleSlots: [] };
  }

  // slot → Set of unique fee-payer addresses that made a buy
  const slotMap = new Map();

  for (const { slot, tx } of txResults) {
    if (!slot) continue;

    const feePayer = extractFeePayer(tx);
    if (!feePayer) continue;

    // Only count actual buy transactions
    if (!isBuyTransaction(tx, mint)) continue;

    if (!slotMap.has(slot)) slotMap.set(slot, new Set());
    slotMap.get(slot).add(feePayer);
  }

  const BUNDLE_WALLET_THRESHOLD = 3;
  const bundleSlots   = [];
  const bundleWallets = new Set();

  for (const [slot, wallets] of slotMap.entries()) {
    if (wallets.size >= BUNDLE_WALLET_THRESHOLD) {
      bundleSlots.push({ slot, walletCount: wallets.size });
      for (const w of wallets) bundleWallets.add(w);
    }
  }

  const isBundle = bundleSlots.length > 0;
  // Confidence scales with number of bundle slots — 1 slot is suspicious,
  // 3+ slots is near-certain. Single slot with exactly 3 wallets gets ~25%.
  const confidence = isBundle
    ? Math.min(100, bundleSlots.length * 25 + Math.max(0, bundleWallets.size - 3) * 5)
    : 0;

  const buyTxsFound = [...slotMap.values()].reduce((s, v) => s + v.size, 0);

  const result = {
    isBundle,
    confidence,
    bundleWallets: [...bundleWallets].slice(0, 10),
    bundleSlots:   bundleSlots.slice(0, 5),
    txsAnalyzed:   txResults.length,
    buyTxsFound,
  };

  if (isBundle) {
    log.warn(`🚨 BUNDLE DETECTED for ${mint.slice(0, 8)}...`, {
      slots:      bundleSlots.length,
      wallets:    bundleWallets.size,
      confidence: confidence + '%',
    });
  } else {
    log.info(`✅ No bundle detected for ${mint.slice(0, 8)}...`, {
      txsAnalyzed: txResults.length,
      buyTxsFound,
    });
  }

  return result;
}

/**
 * Extract the fee payer — always accountKeys[0], must be signer + writable.
 */
function extractFeePayer(tx) {
  try {
    const keys = tx?.transaction?.message?.accountKeys;
    if (!keys?.length) return null;
    const first  = keys[0];
    const pubkey = first?.pubkey || first;
    if (typeof pubkey === 'string' && pubkey.length > 30) return pubkey;
  } catch { /* ignore */ }
  return null;
}

/**
 * Is this tx a token buy?
 * Fee payer must have spent SOL (>= 0.01 SOL net) AND
 * the target token balance must have increased for some wallet.
 */
function isBuyTransaction(tx, targetMint) {
  try {
    if (!tx?.meta) return false;

    // SOL balance check for fee payer (index 0)
    const preSol  = (tx.meta.preBalances?.[0]  || 0) / 1e9;
    const postSol = (tx.meta.postBalances?.[0] || 0) / 1e9;
    if (preSol - postSol < 0.01) return false;

    // Token balance check — did targetMint balance increase for any wallet?
    const postBals = tx.meta.postTokenBalances || [];
    const preBals  = tx.meta.preTokenBalances  || [];

    return postBals.some(b => {
      if (b.mint !== targetMint) return false;
      const pre     = preBals.find(p => p.mint === targetMint && p.owner === b.owner);
      const preAmt  = parseFloat(pre?.uiTokenAmount?.uiAmountString  || '0');
      const postAmt = parseFloat(b.uiTokenAmount?.uiAmountString || '0');
      return postAmt > preAmt;
    });
  } catch { return false; }
}

/**
 * Apply filters.
 * Removed: uniqueBuyers (always 0 post-graduation at enrichment time).
 * Added: Mayhem token filter (MCap < 6K USD at listing = skip).
 */
export function applyFilters(holderSnapshot, bundleResult, token, listingMcapUsd = null) {
  const reasons = [];
  let pass = true;

  // ── Mayhem token filter ─────────────────────
  // Tokens launched under the Mayhem program graduate with very low MCap
  // (typically under $6K USD). These are noise — not tradeable.
  if (listingMcapUsd !== null && listingMcapUsd < 6000) {
    pass = false;
    reasons.push(`Mayhem token: MCap $${listingMcapUsd.toFixed(0)} < $6K threshold`);
  }

  if (!holderSnapshot) {
    log.warn(`No holder snapshot for filter: ${token?.mint?.slice(0, 8)}...`);
  } else {
    if (holderSnapshot.devPct > CONFIG.FILTERS.MAX_DEV_HOLD_PCT) {
      pass = false;
      reasons.push(`Dev holds ${holderSnapshot.devPct}% (max ${CONFIG.FILTERS.MAX_DEV_HOLD_PCT}%)`);
    }
    if (holderSnapshot.top3Pct > CONFIG.FILTERS.MAX_TOP3_CONCENTRATION) {
      pass = false;
      reasons.push(`Top 3 hold ${holderSnapshot.top3Pct}% (max ${CONFIG.FILTERS.MAX_TOP3_CONCENTRATION}%)`);
    }
    if (holderSnapshot.holderCount < 10) {
      pass = false;
      reasons.push(`Only ${holderSnapshot.holderCount} holders (min 10)`);
    }
  }

  if (CONFIG.FILTERS.SKIP_BUNDLE_TOKENS && bundleResult?.isBundle) {
    pass = false;
    reasons.push(`Bundle detected (confidence ${bundleResult.confidence}%)`);
  }

  log.info(`Filter result for ${token?.mint?.slice(0, 8)}...`, {
    pass,
    reasons: reasons.length ? reasons.join('; ') : 'All clear',
  });

  return { pass, reasons };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }