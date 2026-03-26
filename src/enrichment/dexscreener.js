// ─────────────────────────────────────────────
//  enrichment/dexscreener.js
//  Polls DexScreener for price, volume, liquidity
//  Used for post-graduation trade tracking
// ─────────────────────────────────────────────

import fetch from 'node-fetch';
import { CONFIG } from '../config.js';
import createLogger from '../utils/logger.js';

const log = createLogger('DEXSCREENER');

const BASE = CONFIG.DEXSCREENER_API;

// Simple rate limiter: DexScreener allows ~300 req/min free
// We keep a queue and limit to 1 req / 250ms
const queue = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const { fn, resolve, reject } = queue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
    await sleep(250);
  }
  processing = false;
}

function rateLimited(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    processQueue();
  });
}

// ── Core fetcher ───────────────────────────────

async function dexFetch(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log.debug(`DexScreener GET (attempt ${attempt}): ${url}`);
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 429) {
        log.warn(`DexScreener rate limited. Waiting ${2000 * attempt}ms...`);
        await sleep(2000 * attempt);
        continue;
      }

      if (!res.ok) {
        log.warn(`DexScreener HTTP ${res.status}`, { url, attempt });
        if (attempt < retries) { await sleep(1000 * attempt); continue; }
        return null;
      }

      const json = await res.json();
      log.debug(`DexScreener response OK`, { url: url.slice(-40) });
      return json;

    } catch (err) {
      log.warn(`DexScreener fetch error attempt ${attempt}/${retries}`, { err: err.message });
      if (attempt < retries) await sleep(1000 * attempt);
    }
  }
  log.error(`DexScreener exhausted retries for ${url.slice(-40)}`);
  return null;
}

// ── Public API ─────────────────────────────────

/**
 * Get token pairs by mint address
 * Returns array of pair objects
 */
export async function getTokenPairs(mint) {
  return rateLimited(async () => {
    log.info(`Fetching DexScreener pairs for ${mint.slice(0, 8)}...`);
    const data = await dexFetch(`${BASE}/tokens/${mint}`);
    if (!data?.pairs?.length) {
      log.debug(`No pairs found for ${mint.slice(0, 8)}...`);
      return [];
    }

    const solPairs = data.pairs.filter(p => p.chainId === 'solana');
    log.info(`Found ${solPairs.length} Solana pairs for ${mint.slice(0, 8)}...`);
    return solPairs;
  });
}

/**
 * Get the best (highest liquidity) pair for a mint
 * Returns simplified price/volume object
 */
export async function getBestPair(mint) {
  const pairs = await getTokenPairs(mint);
  if (!pairs.length) return null;

  // Sort by liquidity USD descending
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const best = pairs[0];

  const result = {
    pairAddress:     best.pairAddress,
    dex:             best.dexId,
    baseTokenName:   best.baseToken?.name   || null,
    baseTokenSymbol: best.baseToken?.symbol || null,
    priceUsd:      parseFloat(best.priceUsd || '0'),
    priceNative:   parseFloat(best.priceNative || '0'),
    liquidityUsd:  best.liquidity?.usd || 0,
    liquidityBase: best.liquidity?.base || 0,
    vol5m:         best.volume?.m5 || 0,
    vol1h:         best.volume?.h1 || 0,
    vol6h:         best.volume?.h6 || 0,
    vol24h:        best.volume?.h24 || 0,
    txns5m_buys:   best.txns?.m5?.buys || 0,
    txns5m_sells:  best.txns?.m5?.sells || 0,
    txns1h_buys:   best.txns?.h1?.buys || 0,
    txns1h_sells:  best.txns?.h1?.sells || 0,
    priceChange5m: best.priceChange?.m5 || 0,
    priceChange1h: best.priceChange?.h1 || 0,
    fdv:           best.fdv || 0,
    mcap:          best.marketCap || 0,
    pairCreatedAt: best.pairCreatedAt || null,
    url:           best.url || `https://dexscreener.com/solana/${best.pairAddress}`,
  };

  log.info(`Best pair for ${mint.slice(0, 8)}...`, {
    dex: result.dex,
    priceUsd: result.priceUsd.toFixed(8),
    liqUsd: result.liquidityUsd.toFixed(0),
    vol1h: result.vol1h.toFixed(0),
    buyPressure: `${result.txns5m_buys}/${result.txns5m_buys + result.txns5m_sells}`,
  });

  return result;
}

/**
 * Compute buy pressure ratio (0-100) from pair data
 */
export function computeBuyPressure(pair) {
  if (!pair) return 50;
  const totalTxns = pair.txns5m_buys + pair.txns5m_sells;
  if (totalTxns === 0) return 50;
  return Math.round((pair.txns5m_buys / totalTxns) * 100);
}

/**
 * Compute dump signal:
 * Returns { isDump, dropPct, entrySignal } after a token graduates
 * listingPrice = price at first DEX detection
 */
export function analyzeDump(pair, listingPrice) {
  if (!pair || !listingPrice || listingPrice === 0) {
    return { isDump: false, dropPct: 0, entrySignal: false };
  }

  const dropPct = ((listingPrice - pair.priceUsd) / listingPrice) * 100;
  const isDump = dropPct >= CONFIG.DUMP_ENTRY_DROP_PCT;
  const entrySignal = isDump && dropPct <= CONFIG.DUMP_ENTRY_MAX_DROP;

  if (isDump) {
    log.info(`📉 DUMP DETECTED`, {
      listingPrice: listingPrice.toFixed(8),
      currentPrice: pair.priceUsd.toFixed(8),
      dropPct: dropPct.toFixed(2) + '%',
      entrySignal,
    });
  }

  return { isDump, dropPct: parseFloat(dropPct.toFixed(2)), entrySignal };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }