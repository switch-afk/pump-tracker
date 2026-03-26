// PM2 ecosystem config
export default {
  apps: [{
    name:             'pump-scanner',
    script:           './src/index.js',
    interpreter:      'node',
    interpreter_args: '--experimental-vm-modules',
    watch:            false,
    autorestart:      true,
    max_restarts:     10,
    restart_delay:    5000,
    env: {
      NODE_ENV:         'production',
      LOG_LEVEL:        'info',

      // ── Discord ──
      DISCORD_TOKEN:    'YOUR_DISCORD_BOT_TOKEN',
      CH_NEW_TOKENS:    'CHANNEL_ID_NEW_TOKENS',
      CH_SIGNALS:       'CHANNEL_ID_SIGNALS',
      CH_GRADUATED:     'CHANNEL_ID_GRADUATED',
      CH_TRADE_ALERTS:  'CHANNEL_ID_TRADE_ALERTS',
      CH_LOGS:          'CHANNEL_ID_LOGS',

      // ── QuickNode HTTP ──
      QN_HTTP_1:  'https://YOUR-ENDPOINT-1.solana-mainnet.quiknode.pro/TOKEN/',
      QN_HTTP_2:  'https://YOUR-ENDPOINT-2.solana-mainnet.quiknode.pro/TOKEN/',
      QN_HTTP_3:  'https://YOUR-ENDPOINT-3.solana-mainnet.quiknode.pro/TOKEN/',
      QN_HTTP_4:  'https://YOUR-ENDPOINT-4.solana-mainnet.quiknode.pro/TOKEN/',
      QN_HTTP_5:  'https://YOUR-ENDPOINT-5.solana-mainnet.quiknode.pro/TOKEN/',

      // ── QuickNode WS ──
      QN_WS_1:    'wss://YOUR-ENDPOINT-1.solana-mainnet.quiknode.pro/TOKEN/',
      QN_WS_2:    'wss://YOUR-ENDPOINT-2.solana-mainnet.quiknode.pro/TOKEN/',
      QN_WS_3:    'wss://YOUR-ENDPOINT-3.solana-mainnet.quiknode.pro/TOKEN/',
      QN_WS_4:    'wss://YOUR-ENDPOINT-4.solana-mainnet.quiknode.pro/TOKEN/',
      QN_WS_5:    'wss://YOUR-ENDPOINT-5.solana-mainnet.quiknode.pro/TOKEN/',
    },
    log_file:         './data/logs/pm2-combined.log',
    error_file:       './data/logs/pm2-error.log',
    out_file:         './data/logs/pm2-out.log',
    time:             true,
  }]
};
