// ─────────────────────────────────────────────
//  storage/storage.js  —  JSON file persistence
//  - token registry (active tokens map)
//  - per-token snapshot series
//  - graduated tokens record
//  - no external DB dependency
// ─────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import createLogger from '../utils/logger.js';

const log = createLogger('STORAGE');

const DIRS = {
  tokens:     path.join(CONFIG.DATA_DIR, 'tokens'),
  snapshots:  path.join(CONFIG.DATA_DIR, 'snapshots'),
  graduated:  path.join(CONFIG.DATA_DIR, 'graduated'),
};

// Ensure all dirs exist on startup
for (const dir of Object.values(DIRS)) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info(`Created directory: ${dir}`);
  }
}

// ── Generic helpers ───────────────────────────

function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.error(`readJSON failed: ${filePath}`, { err: err.message });
    return fallback;
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    log.error(`writeJSON failed: ${filePath}`, { err: err.message });
    return false;
  }
}

// ── Token Registry ────────────────────────────
// One file per token: data/tokens/{mint}.json
// Contains metadata + current state

export const TokenStore = {
  path: (mint) => path.join(DIRS.tokens, `${mint}.json`),

  save(tokenData) {
    const ok = writeJSON(this.path(tokenData.mint), tokenData);
    if (ok) log.debug(`Saved token: ${tokenData.mint.slice(0, 8)}... stage=${tokenData.stage}`);
    return ok;
  },

  get(mint) {
    return readJSON(this.path(mint));
  },

  exists(mint) {
    return fs.existsSync(this.path(mint));
  },

  delete(mint) {
    try {
      const p = this.path(mint);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      log.debug(`Deleted token file: ${mint.slice(0, 8)}...`);
    } catch (err) {
      log.error(`Failed to delete token ${mint}`, { err: err.message });
    }
  },

  // Returns array of all token objects currently stored
  getAll() {
    try {
      const files = fs.readdirSync(DIRS.tokens).filter(f => f.endsWith('.json'));
      return files.map(f => readJSON(path.join(DIRS.tokens, f))).filter(Boolean);
    } catch (err) {
      log.error('getAll tokens failed', { err: err.message });
      return [];
    }
  },

  count() {
    try {
      return fs.readdirSync(DIRS.tokens).filter(f => f.endsWith('.json')).length;
    } catch { return 0; }
  }
};

// ── Snapshot Store ────────────────────────────
// One file per token: data/snapshots/{mint}.json
// Array of timed snapshots (capped at MAX_SNAPSHOTS_PER_TOKEN)

export const SnapshotStore = {
  path: (mint) => path.join(DIRS.snapshots, `${mint}.json`),

  append(mint, snapshot) {
    const existing = readJSON(this.path(mint), []);
    existing.push({ ...snapshot, ts: Date.now() });

    // Cap to max allowed
    const capped = existing.slice(-CONFIG.MAX_SNAPSHOTS_PER_TOKEN);
    const ok = writeJSON(this.path(mint), capped);
    if (ok) log.debug(`Snapshot appended: ${mint.slice(0, 8)}... total=${capped.length}`);
    return ok;
  },

  getAll(mint) {
    return readJSON(this.path(mint), []);
  },

  getLast(mint, n = 5) {
    const all = readJSON(this.path(mint), []);
    return all.slice(-n);
  },

  // Compute price velocity: change per minute over last N snapshots
  getPriceVelocity(mint, n = 6) {
    const snaps = this.getLast(mint, n);
    if (snaps.length < 2) return 0;
    const oldest = snaps[0];
    const newest = snaps[snaps.length - 1];
    const timeDeltaMins = (newest.ts - oldest.ts) / 60000;
    if (timeDeltaMins === 0) return 0;
    const priceDelta = ((newest.price - oldest.price) / oldest.price) * 100;
    return priceDelta / timeDeltaMins;  // % per minute
  },

  // Compute volume velocity: SOL/min over last N snapshots
  getVolumeVelocity(mint, n = 4) {
    const snaps = this.getLast(mint, n);
    if (snaps.length < 2) return 0;
    const oldest = snaps[0];
    const newest = snaps[snaps.length - 1];
    const timeDeltaMins = (newest.ts - oldest.ts) / 60000;
    if (timeDeltaMins === 0) return 0;
    const volDelta = (newest.volumeSol || 0) - (oldest.volumeSol || 0);
    return Math.max(0, volDelta / timeDeltaMins);
  },

  delete(mint) {
    try {
      const p = this.path(mint);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* non-fatal */ }
  }
};

// ── Graduated Token Store ─────────────────────
// Single file: data/graduated/graduated.json
// Append-only log of all bonded tokens + trade outcomes

export const GraduatedStore = {
  filePath: path.join(DIRS.graduated, 'graduated.json'),

  getAll() {
    return readJSON(this.filePath, []);
  },

  add(tokenData) {
    const all = this.getAll();
    // Avoid duplicates
    if (all.find(t => t.mint === tokenData.mint)) {
      log.debug(`Graduated token already recorded: ${tokenData.mint.slice(0, 8)}...`);
      return false;
    }
    all.push({
      ...tokenData,
      graduatedAt: Date.now(),
      tradeTracking: {
        listingPrice: null,
        lowestAfterListing: null,
        entrySignalPrice: null,
        entrySignalAt: null,
        ath: null,
        currentPrice: null,
        lastUpdated: null,
      }
    });
    const ok = writeJSON(this.filePath, all);
    if (ok) log.info(`🎓 Recorded graduation: ${tokenData.symbol || tokenData.mint.slice(0, 8)}`, { mint: tokenData.mint.slice(0, 8) });
    return ok;
  },

  updateTradeTracking(mint, updates) {
    const all = this.getAll();
    const idx = all.findIndex(t => t.mint === mint);
    if (idx === -1) return false;
    all[idx].tradeTracking = { ...all[idx].tradeTracking, ...updates, lastUpdated: Date.now() };
    return writeJSON(this.filePath, all);
  },

  get(mint) {
    return this.getAll().find(t => t.mint === mint) || null;
  },

  count() {
    return this.getAll().length;
  }
};

// ── Stats snapshot (summary file) ─────────────
// Written periodically for quick health checks

export function writeStatsFile(stats) {
  const p = path.join(CONFIG.DATA_DIR, 'stats.json');
  writeJSON(p, { ...stats, updatedAt: new Date().toISOString() });
}

log.info('Storage layer initialized', {
  tokensDir: DIRS.tokens,
  snapshotsDir: DIRS.snapshots,
  graduatedDir: DIRS.graduated,
});
