// ─────────────────────────────────────────────
//  enrichment/kolWallets.js
//  KOL wallet tracker
//
//  kolwallets.json format (root of project):
//  [ ["Name", "WalletAddress"], ["Name2", "WalletAddress2"], ... ]
//
//  Features:
//  - Load KOL list from kolwallets.json at startup (hot-reloads on file change)
//  - checkKOLsInHolders(topHolders) — check if any KOL is in top holders
//  - subscribeKOLTrades(pumpFeed) — subscribe to all KOL wallet account trades
//  - Emits events when a KOL buys/sells a graduated token
// ─────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import EventEmitter from 'events';
import createLogger from '../utils/logger.js';

const log = createLogger('KOL-WALLETS');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOL_FILE = path.resolve(__dirname, '../../kolwallets.json');

class KOLWalletTracker extends EventEmitter {
  constructor() {
    super();
    // Map of address → name
    this.wallets = new Map();
    this.loaded = false;
    this.fileWatcher = null;
  }

  // ── Load / reload ─────────────────────────────

  load() {
    try {
      if (!fs.existsSync(KOL_FILE)) {
        log.warn(`kolwallets.json not found at ${KOL_FILE}. KOL tracking disabled.`);
        log.warn(`Create the file with format: [["Name","WalletAddress"], ...]`);
        return;
      }

      const raw = fs.readFileSync(KOL_FILE, 'utf8');
      const arr = JSON.parse(raw);

      if (!Array.isArray(arr)) {
        log.error('kolwallets.json must be an array of [name, address] pairs');
        return;
      }

      this.wallets.clear();
      let valid = 0;
      for (const entry of arr) {
        const name    = entry[0] || entry.name;
        const address = entry[1] || entry.address || entry.wallet;
        if (typeof name === 'string' && typeof address === 'string' && address.length > 30) {
          this.wallets.set(address, name);
          valid++;
        }
      }

      this.loaded = true;
      log.info(`✅ KOL wallets loaded: ${valid} wallets`, {
        file: KOL_FILE,
        sample: [...this.wallets.entries()].slice(0, 3).map(([addr, name]) => `${name}(${addr.slice(0,6)}...)`).join(', '),
      });

    } catch (err) {
      log.error('Failed to load kolwallets.json', { err: err.message });
    }
  }

  // Watch for file changes and hot-reload
  watch() {
    if (!fs.existsSync(KOL_FILE)) return;
    this.fileWatcher = fs.watch(KOL_FILE, (eventType) => {
      if (eventType === 'change') {
        log.info('kolwallets.json changed — reloading...');
        this.load();
        this.emit('reloaded', this.wallets.size);
      }
    });
    log.info(`Watching kolwallets.json for changes`);
  }

  // ── Check holders for KOL wallets ────────────

  /**
   * Given a token's topHolders array (from holderSnapshot),
   * return any KOL wallets found in the list.
   * @param {Array} topHolders — [{ address, pct, amount }]
   * @param {string} mint — for logging
   * @returns {Array} matches — [{ name, address, pct }]
   */
  checkHolders(topHolders, mint) {
    if (!this.loaded || this.wallets.size === 0) return [];
    if (!topHolders?.length) return [];

    const matches = [];
    for (const holder of topHolders) {
      const name = this.wallets.get(holder.address);
      if (name) {
        matches.push({
          name,
          address: holder.address,
          pct: holder.pct,
          amount: holder.amount,
        });
        log.info(`🌟 KOL IN HOLDERS: ${name} holds ${holder.pct}% of ${mint?.slice(0, 8)}...`, {
          wallet: holder.address.slice(0, 8) + '...',
          pct: holder.pct + '%',
        });
      }
    }

    if (matches.length > 0) {
      log.info(`🌟 ${matches.length} KOL(s) found in ${mint?.slice(0, 8)}...`, {
        kols: matches.map(m => `${m.name}(${m.pct}%)`).join(', '),
      });
      this.emit('kolsInHolders', mint, matches);
    }

    return matches;
  }

  /**
   * Check ALL known wallets (not just top holders snapshot).
   * Used when we have a full holder list from getTokenLargestAccounts.
   */
  checkAllHolderAddresses(holderAddresses, mint) {
    if (!this.loaded || this.wallets.size === 0) return [];
    const matches = [];
    for (const address of holderAddresses) {
      const name = this.wallets.get(address);
      if (name) {
        matches.push({ name, address });
        log.info(`🌟 KOL WALLET MATCH: ${name} (${address.slice(0, 8)}...) in ${mint?.slice(0, 8)}...`);
      }
    }
    return matches;
  }

  // ── Subscribe to KOL account trades ──────────

  /**
   * Subscribe to all KOL wallet trade events via PumpPortal subscribeAccountTrade.
   * This fires whenever any KOL wallet buys/sells ANY token on pump.fun.
   * Call this after pumpFeed is connected.
   */
  subscribeAllToFeed(pumpFeed) {
    if (!this.loaded || this.wallets.size === 0) {
      log.warn('No KOL wallets loaded — skipping account subscriptions');
      return;
    }

    const addresses = [...this.wallets.keys()];
    log.info(`Subscribing ${addresses.length} KOL wallets via bulk batch...`);
    pumpFeed.subscribeToAccounts(addresses);
    log.info(`✅ All KOL wallet subscriptions sent`);
  }

  // ── Resolve KOL name from address ─────────────

  getName(address) {
    return this.wallets.get(address) || null;
  }

  isKOL(address) {
    return this.wallets.has(address);
  }

  get count() { return this.wallets.size; }

  getAll() {
    return [...this.wallets.entries()].map(([address, name]) => ({ name, address }));
  }
}

export const kolTracker = new KOLWalletTracker();