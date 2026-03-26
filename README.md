# pump-scanner

> Real-time pump.fun graduation monitor with KOL convergence detection, token lifecycle tracking, and data-driven strategy analysis. Runs as a Discord bot.

---

## What it does

pump.fun launches ~30,000 tokens per day. About 300 of them bond and graduate to Raydium or PumpSwap. Most of those dump immediately. This scanner watches every graduation, enriches it with on-chain data, tracks KOL wallet activity, and over time builds a dataset that shows what separates the winners from the dumps.

**Live alerts:**
- Every graduated token → `#graduated` channel (name, MCap, bundle status, holder data, filter result)
- 2+ tracked KOLs buying the same token within 10 minutes → `#trade-alerts` (KOL convergence)
- Token drops 15–45% from DEX listing price → `#trade-alerts` (entry signal)
- KOL wallets found in graduated token's holder list → `#trade-alerts`

**Data collection (passive, always running):**
- Every graduated token tracked for 2 hours: price every 30s, holder snapshots at T+5m/15m/30m/60m, KOL activity, outcome classification
- Strategy analysis report posted to `#logs` every 20 minutes — win rates per signal, optimal filter thresholds, KOL impact

---

## Architecture

```
pumpportal.js          ← Single WebSocket to PumpPortal
  subscribeMigration   ← Every bonded token (~300/day)
  subscribeAccountTrade ← 480 KOL wallets live

registry.js            ← Token state machine
  → enrichment: holder snapshot + bundle check + Mayhem filter
  → scoring: 15s recalc loop

graduationTracker.js   ← DexScreener polling post-graduation
  → price every 30s, ATH tracking, entry signal detection

tokenLifecycle.js      ← 2h exhaustive data recorder per token
  → price series, holder series, KOL activity, outcome classification

kolConvergence.js      ← 10-min sliding window, 2+ KOL threshold
  → alert fires once per convergence (5-min cooldown)

strategyAnalyzer.js    ← Reads lifecycle/index.json
  → win rate per signal, optimal thresholds, recommendations
```

**5 QuickNode endpoints** (HTTP + WS, round-robin) for RPC calls.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/switch-afk/pump-tracker.git
cd pump-tracker
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your Discord token, channel IDs, and QuickNode endpoints
```

You need:
- A Discord bot with `Send Messages`, `Embed Links`, `Read Message History` permissions
- 4 Discord channel IDs (signals, graduated, trade-alerts, logs)
- QuickNode Solana mainnet endpoints (HTTP + WebSocket, ideally 5 of each for round-robin)

### 3. Add KOL wallets

Create `kolwallets.json` in the project root:

```json
[
  ["WalletName", "SolanaAddressHere"],
  ["AnotherKOL", "AnotherAddressHere"]
]
```

The bot watches all these wallets live and fires convergence alerts when 2+ of them buy the same token.

### 4. Run

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm run start

# With PM2
pm2 start ecosystem.config.js
pm2 save
```

---

## Discord Channels

| Channel | What posts there |
|---|---|
| `#signals` | Tokens scoring ≥ 65 (pre-graduation scoring) |
| `#graduated` | Every bonded token — single embed, edited as data arrives |
| `#trade-alerts` | Score ≥ 80, KOL convergence, entry signals, KOL holder alerts |
| `#logs` | 5-min stats, 20-min strategy report, warnings |

---

## Filters

Tokens are filtered during enrichment. Filtered tokens still appear in `#graduated` but marked as filtered. Alerts only fire for tokens that pass all filters.

| Filter | Default | Reason |
|---|---|---|
| Dev hold | > 10% → skip | Dev can dump anytime |
| Top 3 concentration | > 40% → skip | Too concentrated |
| Holder count | < 10 → skip | Not enough distribution |
| Bundle detected | skip if true | Coordinated launch, likely dump |
| Mayhem MCap | < $6K → skip | Mayhem program tokens, not tradeable |

All thresholds are in `src/config.js` and can be tuned based on the strategy analysis report.

---

## Strategy Analysis

After running for a few days, the 20-minute strategy report in `#logs` will show:

- **Base win rate** — what % of all graduated tokens break ATH
- **Signal lift** — does each filter actually predict wins? e.g. "tokens with KOL at graduation: 67% win rate vs 31% base"
- **Optimal thresholds** — what top3% cutoff maximizes win rate based on actual outcomes
- **KOL impact** — which specific KOL names appear most often in winning tokens
- **Recommendations** — concrete config.js changes to improve win rate

Raw data is in `data/lifecycle/index.json`. Each row has outcome, athMultiplier, all pre-grad signals. You can query this yourself.

---

## Data Structure

```
data/
  tokens/           {mint}.json — active token state (in-memory backup)
  snapshots/        {mint}.json — price time-series
  graduated/        graduated.json — all bonded tokens + trade tracking
  lifecycle/
    {mint}.json     — full 2h lifecycle for each token
    index.json      — one-row summary per completed token (for analysis)
    strategy.json   — latest strategy analysis output
  logs/             pump-scanner-YYYY-MM-DD.log
```

---

## Requirements

- Node.js v18+ (v24 recommended — native fetch, no extra deps)
- Discord bot token
- QuickNode Solana mainnet (free tier works, multiple endpoints recommended for rate limit distribution)
- pump.fun API access (public, no key needed)
- DexScreener API (public, no key needed)

---

## Stack

`discord.js v14` · `ws` · `dotenv` · `chalk` · Node.js native `fetch`

No database. All storage is flat JSON files. No external services beyond QuickNode RPC and public APIs.

---

## PM2 Config

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'pump-scanner',
    script: 'src/index.js',
    interpreter: 'node',
    watch: false,
    autorestart: true,
    max_memory_restart: '512M',
  }]
};
```

---

*Built by [@switchndev](https://x.com/sybimeta)*