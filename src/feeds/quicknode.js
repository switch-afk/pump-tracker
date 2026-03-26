// ─────────────────────────────────────────────
//  feeds/quicknode.js  —  QuickNode RPC client
//  Round-robin across 5 HTTP endpoints
//  WS subscriptions distributed across 5 WS endpoints
// ─────────────────────────────────────────────

import fetch from 'node-fetch';
import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import createLogger from '../utils/logger.js';

const log = createLogger('QUICKNODE');

// ── Round-robin HTTP counter ───────────────────
let httpIndex = 0;
function nextHttpEndpoint() {
  const ep = CONFIG.QUICKNODE_HTTP[httpIndex % CONFIG.QUICKNODE_HTTP.length];
  httpIndex++;
  return ep;
}

// ── Core JSON-RPC caller ───────────────────────
export async function rpcCall(method, params = [], retries = 3) {
  const endpoint = nextHttpEndpoint();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log.debug(`RPC ${method} → endpoint #${(httpIndex - 1) % CONFIG.QUICKNODE_HTTP.length + 1}`, { params: JSON.stringify(params).slice(0, 80) });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        log.warn(`RPC HTTP error: ${res.status}`, { method, attempt });
        if (attempt < retries) { await sleep(500 * attempt); continue; }
        return null;
      }

      const json = await res.json();
      if (json.error) {
        log.warn(`RPC error response`, { method, code: json.error.code, msg: json.error.message });
        return null;
      }

      log.debug(`RPC ${method} success`, { attempt });
      return json.result;

    } catch (err) {
      log.warn(`RPC attempt ${attempt}/${retries} failed: ${err.message}`, { method });
      if (attempt < retries) await sleep(500 * attempt);
    }
  }

  log.error(`RPC ${method} exhausted all retries`);
  return null;
}

// ── Solana helpers ─────────────────────────────

/**
 * Get token largest accounts (top holders)
 * Returns array of { address, uiAmount }
 */
export async function getTokenLargestAccounts(mint) {
  log.debug(`Fetching largest accounts for ${mint.slice(0, 8)}...`);
  const result = await rpcCall('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  if (!result?.value) {
    log.warn(`No holder data for ${mint.slice(0, 8)}...`);
    return [];
  }
  log.info(`Got ${result.value.length} largest accounts for ${mint.slice(0, 8)}...`);
  return result.value.map(a => ({ address: a.address, amount: parseFloat(a.uiAmountString || '0') }));
}

/**
 * Get account info for a mint (checks if it exists + decimals)
 */
export async function getAccountInfo(address) {
  log.debug(`getAccountInfo: ${address.slice(0, 8)}...`);
  const result = await rpcCall('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return result?.value || null;
}

/**
 * Get recent signatures for an address (transaction history)
 * @param {string} address
 * @param {number} limit
 */
export async function getSignatures(address, limit = 50) {
  log.debug(`getSignatures: ${address.slice(0, 8)}... limit=${limit}`);
  const result = await rpcCall('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
  if (!result) return [];
  log.debug(`Got ${result.length} signatures for ${address.slice(0, 8)}...`);
  return result;
}

/**
 * Get parsed transaction — used for bundle detection
 */
export async function getParsedTransaction(signature) {
  log.debug(`getParsedTransaction: ${signature.slice(0, 16)}...`);
  const result = await rpcCall('getTransaction', [
    signature,
    { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
  ]);
  return result;
}

/**
 * Get token supply
 */
export async function getTokenSupply(mint) {
  log.debug(`getTokenSupply: ${mint.slice(0, 8)}...`);
  const result = await rpcCall('getTokenSupply', [mint, { commitment: 'confirmed' }]);
  return result?.value?.uiAmount || 0;
}

// ── QuickNode WS Subscription Manager ─────────
// Distributes account subscriptions across 5 WS connections

class QNWebSocketPool {
  constructor() {
    this.connections = [];
    this.subIndex = 0;
    this.subscriptions = new Map();  // subId -> { mint, wsIdx, callback }
    this.reconnectTimers = new Map();
    this.pendingSubs = [];           // subs queued before WS ready
  }

  async init() {
    log.section('Initializing QuickNode WebSocket Pool');
    for (let i = 0; i < CONFIG.QUICKNODE_WS.length; i++) {
      await this._connect(i);
    }
    log.info(`QN WS Pool ready: ${this.connections.filter(c => c?.readyState === WebSocket.OPEN).length}/${CONFIG.QUICKNODE_WS.length} connections open`);
  }

  _connect(idx) {
    return new Promise((resolve) => {
      const url = CONFIG.QUICKNODE_WS[idx];
      log.info(`Connecting QN WS #${idx + 1}...`, { url: url.slice(0, 40) + '...' });

      const ws = new WebSocket(url);
      this.connections[idx] = ws;

      ws.on('open', () => {
        log.info(`QN WS #${idx + 1} connected`);
        resolve(ws);
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(idx, msg);
        } catch (err) {
          log.error(`QN WS #${idx + 1} parse error`, { err: err.message });
        }
      });

      ws.on('error', (err) => {
        log.error(`QN WS #${idx + 1} error`, { err: err.message });
      });

      ws.on('close', (code) => {
        log.warn(`QN WS #${idx + 1} closed, code=${code}. Reconnecting in 5s...`);
        this._scheduleReconnect(idx);
      });

      // Resolve after timeout even if not connected yet
      setTimeout(() => resolve(ws), 5000);
    });
  }

  _scheduleReconnect(idx) {
    if (this.reconnectTimers.has(idx)) return;
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(idx);
      await this._connect(idx);
      log.info(`QN WS #${idx + 1} reconnected`);
    }, 5000);
    this.reconnectTimers.set(idx, timer);
  }

  _handleMessage(wsIdx, msg) {
    // Subscription confirmation
    if (msg.id && msg.result !== undefined && typeof msg.result === 'number') {
      log.debug(`QN WS #${wsIdx + 1} subscription confirmed, subId=${msg.result}`, { reqId: msg.id });
      // Map request ID to actual subId
      for (const [key, val] of this.subscriptions.entries()) {
        if (val.reqId === msg.id && val.wsIdx === wsIdx) {
          val.subId = msg.result;
          this.subscriptions.set(key, val);
          break;
        }
      }
      return;
    }

    // Account notification
    if (msg.method === 'accountNotification' && msg.params) {
      const { subscription, result } = msg.params;
      for (const [mint, val] of this.subscriptions.entries()) {
        if (val.subId === subscription && val.wsIdx === wsIdx) {
          log.debug(`QN WS #${wsIdx + 1} account notification for ${mint.slice(0, 8)}...`);
          val.callback(result, mint);
          break;
        }
      }
    }
  }

  // Subscribe to account changes for a mint
  subscribeAccount(mint, callback) {
    if (this.subscriptions.has(mint)) {
      log.debug(`Already subscribed to ${mint.slice(0, 8)}...`);
      return;
    }

    const wsIdx = this.subIndex % CONFIG.QUICKNODE_WS.length;
    this.subIndex++;

    const ws = this.connections[wsIdx];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn(`QN WS #${wsIdx + 1} not ready, queuing subscription for ${mint.slice(0, 8)}...`);
      this.pendingSubs.push({ mint, callback });
      return;
    }

    const reqId = Date.now() + Math.floor(Math.random() * 1000);
    const subReq = {
      jsonrpc: '2.0',
      id: reqId,
      method: 'accountSubscribe',
      params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]
    };

    this.subscriptions.set(mint, { wsIdx, reqId, subId: null, callback });
    ws.send(JSON.stringify(subReq));
    log.info(`Subscribed to account ${mint.slice(0, 8)}... via QN WS #${wsIdx + 1}`);
  }

  unsubscribeAccount(mint) {
    const sub = this.subscriptions.get(mint);
    if (!sub) return;

    const ws = this.connections[sub.wsIdx];
    if (ws?.readyState === WebSocket.OPEN && sub.subId) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: Date.now(),
        method: 'accountUnsubscribe',
        params: [sub.subId]
      }));
    }
    this.subscriptions.delete(mint);
    log.debug(`Unsubscribed from ${mint.slice(0, 8)}...`);
  }

  get activeSubscriptions() { return this.subscriptions.size; }
}

export const qnWSPool = new QNWebSocketPool();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
