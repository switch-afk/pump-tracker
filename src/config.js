// ─────────────────────────────────────────────
//  config.js  —  central config for pump-scanner
// ─────────────────────────────────────────────

export const CONFIG = {

  // ── Discord ───────────────────────────────
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_BOT_TOKEN',
  CHANNELS: {
    NEW_TOKENS:    process.env.CH_NEW_TOKENS    || 'CHANNEL_ID_NEW_TOKENS',
    SIGNALS:       process.env.CH_SIGNALS       || 'CHANNEL_ID_SIGNALS',
    GRADUATED:     process.env.CH_GRADUATED     || 'CHANNEL_ID_GRADUATED',
    TRADE_ALERTS:  process.env.CH_TRADE_ALERTS  || 'CHANNEL_ID_TRADE_ALERTS',
    LOGS:          process.env.CH_LOGS          || 'CHANNEL_ID_LOGS',
  },

  // ── QuickNode — 5 HTTP + 5 WS endpoints ──
  // Round-robin used across them to spread load
  QUICKNODE_HTTP: [
    process.env.QN_HTTP_1 || 'https://YOUR-ENDPOINT-1.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_HTTP_2 || 'https://YOUR-ENDPOINT-2.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_HTTP_3 || 'https://YOUR-ENDPOINT-3.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_HTTP_4 || 'https://YOUR-ENDPOINT-4.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_HTTP_5 || 'https://YOUR-ENDPOINT-5.solana-mainnet.quiknode.pro/TOKEN/',
  ],
  QUICKNODE_WS: [
    process.env.QN_WS_1 || 'wss://YOUR-ENDPOINT-1.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_WS_2 || 'wss://YOUR-ENDPOINT-2.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_WS_3 || 'wss://YOUR-ENDPOINT-3.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_WS_4 || 'wss://YOUR-ENDPOINT-4.solana-mainnet.quiknode.pro/TOKEN/',
    process.env.QN_WS_5 || 'wss://YOUR-ENDPOINT-5.solana-mainnet.quiknode.pro/TOKEN/',
  ],

  // ── PumpPortal ────────────────────────────
  PUMPPORTAL_WS: 'wss://pumpportal.fun/api/data',

  // ── DexScreener ──────────────────────────
  DEXSCREENER_API: 'https://api.dexscreener.com/latest/dex',

  // ── Stage thresholds ─────────────────────
  STAGES: {
    LAUNCH:          { min: 0,   max: 20  },   // bonding curve %
    EARLY_GROWTH:    { min: 20,  max: 50  },
    MOMENTUM:        { min: 50,  max: 75  },
    BONDING_ZONE:    { min: 75,  max: 99  },
    GRADUATED:       { min: 100, max: 100 },
  },

  // ── Scoring weights (must sum to 1.0) ────
  SCORE_WEIGHTS: {
    bondingPercent:   0.25,
    volumeVelocity:   0.20,
    uniqueBuyers:     0.20,
    buyPressure:      0.15,
    holderScore:      0.10,
    bundleClean:      0.10,
  },

  // ── Signal thresholds ────────────────────
  SIGNAL_SCORE_MIN:       65,    // minimum score to post to #signals
  TRADE_ALERT_SCORE_MIN:  80,    // minimum score to post to #trade-alerts
  GRADUATED_TRACK_MINS:   60,    // how long to track post-graduation
  DUMP_ENTRY_DROP_PCT:    15,    // % drop from listing price to flag entry
  DUMP_ENTRY_MAX_DROP:    45,    // % drop above which skip (too far gone)

  // ── Filters — skip if any true ───────────
  FILTERS: {
    MAX_DEV_HOLD_PCT:         10,   // dev wallet > 10% → skip
    MAX_TOP3_CONCENTRATION:   40,   // top 3 wallets > 40% → skip
    MIN_UNIQUE_BUYERS:        25,   // < 25 unique buyers → skip
    SKIP_BUNDLE_TOKENS:       true, // skip if bundle detected
    MIN_BOND_TIME_SECS:       120,  // bonded in < 2 min → likely bot, skip
  },

  // ── Polling intervals ────────────────────
  INTERVALS: {
    DEXSCREENER_POLL_MS:    30_000,   // poll DexScreener every 30s
    HOLDER_SNAPSHOT_MS:     60_000,   // holder snapshot every 60s
    SCORE_RECALC_MS:        15_000,   // recalc score every 15s
    CLEANUP_MS:             300_000,  // cleanup stale tokens every 5 min
    LOG_FLUSH_MS:           10_000,   // flush log buffer every 10s
  },

  // ── Tracking caps ─────────────────────────
  MAX_ACTIVE_TOKENS:      500,    // max tokens in registry at once
  STALE_TOKEN_MINS:        30,    // remove tokens with no activity after 30 min (unless graduated)
  MAX_SNAPSHOTS_PER_TOKEN: 120,   // max time-series snapshots stored per token

  // ── Misc ──────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',   // debug | info | warn | error
  DATA_DIR:  './data',
};
