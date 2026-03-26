// ─────────────────────────────────────────────
//  feeds/pumpportal.js  —  PumpPortal WebSocket
//
//  Single WS connection to wss://pumpportal.fun/api/data
//  Subscriptions:
//    subscribeMigration  — every bonded/graduated token (the ONLY ones we care about)
//    subscribeTokenTrade — trade stream for specific mints post-graduation
//
//  subscribeNewToken is intentionally NOT used.
//  30k tokens launch per day, only ~300 bond. We watch migrations only.
//
//  Per PumpPortal docs: ONE connection only, send all subscribes to it.
// ─────────────────────────────────────────────

import WebSocket from 'ws';
import EventEmitter from 'events';
import { CONFIG } from '../config.js';
import createLogger from '../utils/logger.js';

const log = createLogger('PUMPPORTAL');

class PumpPortalFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.reconnectDelay = 3000;
    this.maxReconnectDelay = 60000;
    this.subscribedMints = new Set();   // mints we sent subscribeTokenTrade for
    this.pingInterval = null;
    this.stats = {
      totalTradesSeen:      0,
      totalMigrationsSeen:  0,
      connectedAt:          null,
      reconnects:           0,
    };
  }

  // ── Public: connect ───────────────────────────

  connect() {
    log.section('Connecting to PumpPortal WebSocket');
    log.info(`Endpoint: ${CONFIG.PUMPPORTAL_WS}`);
    this._createConnection();
  }

  // ── Internal: connection lifecycle ────────────

  _createConnection() {
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }

    log.info('Opening PumpPortal WebSocket...');
    this.ws = new WebSocket(CONFIG.PUMPPORTAL_WS);

    this.ws.on('open', () => {
      log.info('✅ PumpPortal WebSocket connected');
      this.connected = true;
      this.reconnectDelay = 3000;
      this.stats.connectedAt = Date.now();

      // Only two subscriptions — migrations (global) + any token trades we restore
      this._subscribeMigrations();

      // Re-subscribe to any token trade streams active before reconnect
      if (this.subscribedMints.size > 0) {
        const mints = [...this.subscribedMints];
        log.info(`Re-subscribing to ${mints.length} token trade streams after reconnect`);
        // Send in batches of 100 to avoid oversized messages
        for (let i = 0; i < mints.length; i += 100) {
          this._sendSubscribe('subscribeTokenTrade', mints.slice(i, i + 100));
        }
      }

      this._startPing();
      this.emit('connected');
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this._handleMessage(data);
      } catch (err) {
        log.error('Failed to parse PumpPortal message', { err: err.message, raw: raw.toString().slice(0, 100) });
      }
    });

    this.ws.on('error', (err) => {
      log.error('PumpPortal WS error', { err: err.message });
      this.connected = false;
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this._stopPing();
      const reasonStr = reason?.toString() || 'no reason given';
      log.warn(`PumpPortal WS closed`, {
        code,
        reason: reasonStr,
        reconnectIn: `${(this.reconnectDelay / 1000).toFixed(1)}s`,
        totalReconnects: this.stats.reconnects + 1,
      });
      this.stats.reconnects++;
      this._scheduleReconnect();
    });

    this.ws.on('pong', () => {
      log.debug('PumpPortal pong received');
    });
  }

  _scheduleReconnect() {
    setTimeout(() => {
      log.info(`Reconnecting to PumpPortal (attempt #${this.stats.reconnects})...`);
      this._createConnection();
    }, this.reconnectDelay);

    // Exponential backoff, capped at 60s
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
  }

  // ── Subscription senders ──────────────────────

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn('Tried to send to PumpPortal WS while not connected', { method: payload.method });
      return false;
    }
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  _sendSubscribe(method, keys = null) {
    const payload = keys ? { method, keys } : { method };
    const sent = this._send(payload);
    if (sent) {
      log.debug(`Sent ${method}`, keys ? { count: keys.length, first: keys[0]?.slice(0, 8) + '...' } : {});
    }
    return sent;
  }

  /**
   * subscribeMigration — global subscription, no keys needed.
   * Fires whenever any pump.fun token bonds and migrates to Raydium/PumpSwap.
   * ~300 events per day. This is the only entry point we care about.
   */
  _subscribeMigrations() {
    const sent = this._sendSubscribe('subscribeMigration');
    if (sent) log.info('🎓 Subscribed to subscribeMigration (all bonded tokens)');
  }

  // ── Ping/pong keepalive ───────────────────────

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        log.debug('Sent ping to PumpPortal');
      }
    }, 30_000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ── Message router ────────────────────────────

  _handleMessage(data) {

    // ── Token trade ───────────────────────────────
    // Only received for mints we explicitly subscribeTokenTrade on
    if (data.txType === 'buy' || data.txType === 'sell') {
      this.stats.totalTradesSeen++;

      const trade = {
        mint:                   data.mint,
        type:                   data.txType,              // 'buy' | 'sell'
        solAmount:              data.solAmount       || 0,
        tokenAmount:            data.tokenAmount     || 0,
        trader:                 data.traderPublicKey,
        marketCapSol:           data.marketCapSol    || 0,
        bondingCurve:           data.bondingCurveKey  || null,
        vSolInBondingCurve:     data.vSolInBondingCurve     || 0,
        vTokensInBondingCurve:  data.vTokensInBondingCurve  || 0,
        ts:                     Date.now(),
        txSignature:            data.signature,
      };

      // Bonding % — pump.fun bonds when curve reaches ~85 SOL
      trade.bondingPct = Math.min(100, (trade.vSolInBondingCurve / 85) * 100);

      log.debug(`💱 ${trade.type.toUpperCase()} ${trade.mint.slice(0, 8)}...`, {
        sol:      trade.solAmount.toFixed(4),
        bonding:  trade.bondingPct.toFixed(1) + '%',
        mcapSOL:  trade.marketCapSol.toFixed(2),
        trader:   trade.trader.slice(0, 8) + '...',
      });

      this.emit('trade', trade);
      return;
    }

    // ── Migration / Graduation ────────────────────
    // Comes from subscribeMigration subscription.
    // Fields per PumpPortal docs: mint, signature, pool (raydium/pumpswap), and
    // any additional metadata PumpPortal includes at time of migration.
    if (
      data.txType === 'migrate'    ||
      data.txType === 'migration'  ||
      data.type   === 'migration'  ||
      data.method === 'migration'
    ) {
      this.stats.totalMigrationsSeen++;

      const graduation = {
        mint:         data.mint,
        signature:    data.signature    || null,
        pool:         data.pool         || data.raydiumPool || null,   // 'raydium' | 'pumpswap' | null
        poolAddress:  data.poolAddress  || data.lpMint     || null,
        name:         data.name         || null,
        symbol:       data.symbol       || null,
        ts:           Date.now(),
        // Pass through any extra fields PumpPortal sends
        raw:          data,
      };

      log.info(`🎓 MIGRATION EVENT: [${graduation.symbol || '???'}] ${graduation.mint?.slice(0, 8)}...`, {
        mint:        graduation.mint,
        pool:        graduation.pool,
        poolAddress: graduation.poolAddress?.slice(0, 8),
        signature:   graduation.signature?.slice(0, 16) + '...',
        totalMigrationsSeen: this.stats.totalMigrationsSeen,
      });

      this.emit('graduated', graduation);
      return;
    }

    // ── Subscription confirmations ─────────────────
    // PumpPortal sends one ack per subscribe call. With 480 KOL wallets
    // this floods the log. Deduplicate: log unique messages at info,
    // batch repeats into a single summary every 50.
    if (data.message && typeof data.message === 'string') {
      const msg = data.message;
      if (!this._ackCounts) this._ackCounts = new Map();
      const prev = this._ackCounts.get(msg) || 0;
      this._ackCounts.set(msg, prev + 1);

      if (prev === 0) {
        // First time seeing this message — log it
        log.info(`PumpPortal ack: ${msg}`);
      } else if (prev % 50 === 0) {
        // Every 50 repeats log a count summary
        log.info(`PumpPortal ack: "${msg}" — received ${prev + 1}x total`);
      }
      // Otherwise swallow silently
      return;
    }

    log.debug('Unhandled PumpPortal message', {
      txType: data.txType,
      type:   data.type,
      keys:   Object.keys(data).slice(0, 6).join(', '),
    });
  }

  // ── Public API ────────────────────────────────

  /**
   * Subscribe to trade events for a specific token mint.
   * Uses the single existing WS connection — no new connections opened.
   */
  subscribeToToken(mint) {
    if (this.subscribedMints.has(mint)) {
      log.debug(`Already subscribed to trades for: ${mint.slice(0, 8)}...`);
      return;
    }
    this.subscribedMints.add(mint);
    this._sendSubscribe('subscribeTokenTrade', [mint]);
    log.info(`📡 Subscribed to token trades: ${mint.slice(0, 8)}...`, {
      totalSubscribed: this.subscribedMints.size,
    });
  }

  /**
   * Unsubscribe from a token's trade stream.
   */
  unsubscribeFromToken(mint) {
    if (!this.subscribedMints.has(mint)) return;
    this.subscribedMints.delete(mint);
    this._sendSubscribe('unsubscribeTokenTrade', [mint]);
    log.info(`🔕 Unsubscribed from token trades: ${mint.slice(0, 8)}...`, {
      totalSubscribed: this.subscribedMints.size,
    });
  }

  /**
   * Subscribe to all trades made by a wallet address.
   * silent=true suppresses per-wallet log (used for bulk KOL subscribe).
   */
  subscribeToAccount(walletAddress, silent = false) {
    this._sendSubscribe('subscribeAccountTrade', [walletAddress]);
    if (!silent) {
      log.info(`👀 Subscribed to account trades: ${walletAddress.slice(0, 8)}...`);
    }
  }

  /**
   * Subscribe to multiple account addresses in batches of 25.
   * Logs a single summary line instead of one line per wallet.
   */
  subscribeToAccounts(addresses) {
    if (!addresses.length) return;
    const BATCH = 25;
    let sent = 0;
    for (let i = 0; i < addresses.length; i += BATCH) {
      this._sendSubscribe('subscribeAccountTrade', addresses.slice(i, i + BATCH));
      sent += Math.min(BATCH, addresses.length - i);
    }
    log.info(`👀 Bulk subscribed to ${sent} account trade streams (${Math.ceil(sent / BATCH)} batches)`);
  }

  /**
   * Unsubscribe from account trade stream.
   */
  unsubscribeFromAccount(walletAddress) {
    this._sendSubscribe('unsubscribeAccountTrade', [walletAddress]);
    log.info(`🔕 Unsubscribed from account trades: ${walletAddress.slice(0, 8)}...`);
  }

  getStats() {
    return {
      ...this.stats,
      connected:       this.connected,
      subscribedMints: this.subscribedMints.size,
      uptimeMs:        this.stats.connectedAt ? Date.now() - this.stats.connectedAt : 0,
    };
  }
}

export const pumpFeed = new PumpPortalFeed();