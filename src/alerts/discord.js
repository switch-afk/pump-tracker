// ─────────────────────────────────────────────
//  alerts/discord.js  —  Discord bot + embeds
//  Channels:
//    #new-tokens     — every new token (rate limited)
//    #signals        — score >= SIGNAL_SCORE_MIN
//    #graduated      — graduation events + DEX listing
//    #trade-alerts   — entry zone signals 🎯
//    #logs           — warn/error log flush
// ─────────────────────────────────────────────

import { Client, GatewayIntentBits, EmbedBuilder, ActivityType } from 'discord.js';
import { CONFIG } from '../config.js';
import { setDiscordClientForLogger } from '../utils/logger.js';
import createLogger from '../utils/logger.js';

const log = createLogger('DISCORD');

// ── Color palette ──────────────────────────────
const COLORS = {
  LAUNCH:       0xF97316,  // orange
  EARLY_GROWTH: 0xEAB308,  // yellow
  MOMENTUM:     0x3B82F6,  // blue
  BONDING_ZONE: 0x22C55E,  // green
  GRADUATED:    0xA855F7,  // purple
  SIGNAL:       0x06B6D4,  // cyan
  TRADE_ALERT:  0xF43F5E,  // rose/red
  ENTRY_SIGNAL: 0x10B981,  // emerald
  INFO:         0x6B7280,  // gray
  WARN:         0xF59E0B,  // amber
  ERROR:        0xEF4444,  // red
};

const STAGE_COLOR = (stage) => COLORS[stage] || COLORS.INFO;

// ── Rate limiter removed — no new token feed ──
// We only post graduated tokens and signals.

// ── Discord ready flag ─────────────────────────
// All send functions check this before attempting to send.
// If Discord is not configured / failed to login, alerts are silently skipped
// and the scanner keeps running normally.
let discordReady = false;

export function isDiscordReady() { return discordReady; }

// ── Client setup ──────────────────────────────

export const discordBot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

discordBot.once('ready', () => {
  discordReady = true;
  log.info(`✅ Discord bot ready: ${discordBot.user.tag}`);
  setDiscordClientForLogger(discordBot);

  discordBot.user.setActivity('pump.fun | migrations', { type: ActivityType.Watching });
});

discordBot.on('error', (err) => {
  log.error('Discord client error', { err: err.message });
});

/**
 * Connect Discord bot.
 * NON-FATAL — if token is missing or invalid the scanner continues
 * running and simply skips Discord alerts.
 */
export async function connectDiscord() {
  const token = CONFIG.DISCORD_TOKEN;

  if (!token || token === 'YOUR_DISCORD_BOT_TOKEN') {
    log.warn('⚠️  DISCORD_TOKEN not set — Discord alerts disabled. Scanner will still run.');
    log.warn('    Set DISCORD_TOKEN in your .env file and restart to enable alerts.');
    return;
  }

  log.info('Connecting Discord bot...');
  try {
    await discordBot.login(token);
    log.info('Discord login initiated — waiting for ready event...');
  } catch (err) {
    log.warn(`⚠️  Discord login failed: ${err.message}`);
    log.warn('    Scanner will continue without Discord alerts.');
    log.warn('    Fix your DISCORD_TOKEN in .env and restart to enable alerts.');
    // Do NOT throw — let boot continue
  }
}

// ── Channel getter ─────────────────────────────

function getChannel(id) {
  const ch = discordBot.channels.cache.get(id);
  if (!ch) log.warn(`Discord channel not found: ${id}`);
  return ch;
}

async function send(channelId, payload) {
  const ch = getChannel(channelId);
  if (!ch) return null;
  try {
    return await ch.send(payload);
  } catch (err) {
    log.error(`Failed to send Discord message to ${channelId}`, { err: err.message });
    return null;
  }
}

// ── Embed builders ─────────────────────────────

// Graduation message cache — one message per token, edited as data arrives
const graduationMessages = new Map();

function buildSignalEmbed(token, signal) {
  const score = token.scoreResult?.score || 0;
  const grade = token.scoreResult?.grade || '?';
  const hs = token.holderSnapshot;

  const embed = new EmbedBuilder()
    .setColor(signal.level === 'TRADE_ALERT' ? COLORS.TRADE_ALERT : COLORS.SIGNAL)
    .setTitle(`${signal.level === 'TRADE_ALERT' ? '🔥' : '📡'} ${token.symbol} — ${signal.level}`)
    .setDescription(`**Score: ${score}/100 (${grade})** — ${signal.reason}`)
    .addFields(
      { name: 'Stage',      value: token.stage,                    inline: true },
      { name: 'Bonding',    value: `${token.bondingPct?.toFixed(1) || 0}%`, inline: true },
      { name: 'MCap',       value: `${token.marketCapSol?.toFixed(2) || 0} SOL`, inline: true },
      { name: 'Volume',     value: `${token.totalVolumeSol?.toFixed(3) || 0} SOL`, inline: true },
      { name: 'Buyers',     value: `${token.uniqueBuyers || 0}`,   inline: true },
      { name: 'Buy/Sell',   value: `${token.buyCount || 0}/${token.sellCount || 0}`, inline: true },
    );

  if (hs) {
    embed.addFields(
      { name: 'Dev Hold',   value: `${hs.devPct}%`,   inline: true },
      { name: 'Top 3 Hold', value: `${hs.top3Pct}%`,  inline: true },
      { name: 'Holder Score', value: `${hs.holderScore}`, inline: true },
    );
  }

  if (token.bundleResult?.isBundle) {
    embed.addFields({ name: '⚠️ Bundle', value: `Detected (${token.bundleResult.confidence}% confidence)`, inline: false });
  }

  embed.addFields({ name: 'Mint', value: `\`${token.mint}\``, inline: false })
    .addFields({
      name: 'Links',
      value: [
        `[Pump.fun](https://pump.fun/${token.mint})`,
        `[DexScreener](https://dexscreener.com/solana/${token.mint})`,
        `[Solscan](https://solscan.io/token/${token.mint})`,
      ].join(' · ')
    })
    .setTimestamp()
    .setFooter({ text: `pump-scanner · ${signal.level.toLowerCase()}` });

  return embed;
}

function buildGraduationEmbed(token, pair = null, enrichmentDone = false) {
  const filterResult = token.filterResult;
  const hs = token.holderSnapshot;
  const bundled = token.bundleResult?.isBundle;
  const kolMatches = hs?.kolMatches || [];

  // Name + symbol resolution
  const name   = pair?.baseTokenName  || (token.name   !== 'Unknown' ? token.name   : null);
  const symbol = pair?.baseTokenSymbol || token.symbol;
  const title  = name && name.toLowerCase() !== symbol.toLowerCase()
    ? `🎓 ${name} (${symbol}) — GRADUATED`
    : `🎓 ${symbol} — GRADUATED`;

  // MCap — prefer live USD from pair, fallback to pump.fun API, then SOL estimate
  const mcapDisplay = pair?.mcap
    ? formatUsd(pair.mcap)
    : pair?.fdv
    ? formatUsd(pair.fdv)
    : token.listingMcapUsd
    ? formatUsd(token.listingMcapUsd)
    : formatMcapSol(token.marketCapSol);

  // Price change display
  const pctChange = (pct) => {
    if (pct == null || pct === 0) return '—';
    return pct >= 0 ? `🟢 +${pct.toFixed(2)}%` : `🔴 ${pct.toFixed(2)}%`;
  };

  // Filter status
  let filterValue;
  if (!enrichmentDone) {
    filterValue = '⏳ Checking...';
  } else if (filterResult?.pass === false) {
    filterValue = `❌ ${filterResult.reasons[0]}`;
  } else {
    filterValue = '✅ Passed';
  }

  // Bundle status
  const bundleValue = !enrichmentDone
    ? '⏳'
    : bundled
    ? `🚨 ${token.bundleResult.confidence}%`
    : '✅ Clean';

  const color = !enrichmentDone ? COLORS.INFO
    : filterResult?.pass === false ? COLORS.ERROR
    : COLORS.GRADUATED;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`Bonded and migrated · Pool: \`${token.pool || 'unknown'}\``);

  // Token image — from pair info or pump.fun API cache
  const imgUrl = pair?.imageUrl || token.imageUrl || null;
  if (imgUrl) embed.setThumbnail(imgUrl);

  // Mint
  embed.addFields({ name: 'Mint', value: `\`${token.mint}\``, inline: false });

  // Row 1: Filter | Bundle | Dev Hold
  embed.addFields(
    { name: 'Filter',    value: filterValue,  inline: true },
    { name: 'Bundle',    value: bundleValue,  inline: true },
    { name: 'Dev Hold',  value: hs ? `${hs.devPct}%` : '—', inline: true },
  );

  // Row 2: Top 3 Hold | Holder Score | Holders
  if (hs) {
    embed.addFields(
      { name: 'Top 3 Hold',    value: `${hs.top3Pct}%`,       inline: true },
      { name: 'Holder Score',  value: `${hs.holderScore}/100`, inline: true },
      { name: 'Holders',       value: `${hs.holderCount}`,     inline: true },
    );
  }

  // KOL holders
  if (enrichmentDone && kolMatches.length > 0) {
    const kolList = kolMatches.slice(0, 5).map(k => `🌟 **${k.name}**`).join(', ');
    embed.addFields({ name: `KOL Holders (${kolMatches.length})`, value: kolList, inline: false });
  }

  // Market data
  if (pair) {
    // Row 3: MCap | Listing Price | Liquidity
    embed.addFields(
      { name: 'MCap',          value: mcapDisplay,                          inline: true },
      { name: 'Listing Price', value: `$${pair.priceUsd.toFixed(8)}`,       inline: true },
      { name: 'Liquidity',     value: formatUsd(pair.liquidityUsd),         inline: true },
    );
    // Row 4: DEX | Vol 1h | Buy Pressure
    embed.addFields(
      { name: 'DEX',           value: pair.dex,                             inline: true },
      { name: 'Vol 1h',        value: formatUsd(pair.vol1h),                inline: true },
      { name: 'Buy Pressure',  value: `${pair.txns1h_buys}B / ${pair.txns1h_sells}S`, inline: true },
    );
    // Row 5: 1h change | 24h change | Pairs
    embed.addFields(
      { name: '1h Change',     value: pctChange(pair.priceChange1h),        inline: true },
      { name: '24h Change',    value: pctChange(pair.priceChange24h),       inline: true },
      { name: 'Pairs',         value: `${pair.pairCount || 1}`,             inline: true },
    );
    // Chart
    embed.addFields({ name: 'Chart', value: `[View on DexScreener](${pair.url})`, inline: false });
  } else {
    embed.addFields(
      { name: 'MCap',        value: mcapDisplay,                 inline: true },
      { name: 'DEX Listing', value: '⏳ Waiting...',             inline: true },
      { name: '\u200b',      value: '\u200b',                    inline: true },
    );
  }

  // Socials from pair if available
  if (pair?.websites?.length || pair?.socials?.length) {
    const links = [];
    for (const w of (pair.websites || [])) if (w?.url) links.push(`[Website](${w.url})`);
    for (const s of (pair.socials  || [])) if (s?.url) links.push(`[${s.platform || s.type || 'Social'}](${s.url})`);
    if (links.length) embed.addFields({ name: 'Socials', value: links.join(' · '), inline: false });
  }

  // Links
  embed.addFields({
    name: 'Links',
    value: [
      `[Pump.fun](https://pump.fun/${token.mint})`,
      `[DexScreener](https://dexscreener.com/solana/${token.mint})`,
      `[Solscan](https://solscan.io/token/${token.mint})`,
    ].join(' · ')
  })
  .setTimestamp()
  .setFooter({ text: 'pump-scanner · graduation' });

  return embed;
}

function buildEntrySignalEmbed(token, pair, dumpData) {
  const {
    listingPrice, currentPrice, dropPct,
    buyPressure, sellPressure, vol5m,
    liquidityUsd, dexUrl
  } = dumpData;

  const totalTxns = buyPressure + sellPressure;
  const buyPct = totalTxns > 0 ? ((buyPressure / totalTxns) * 100).toFixed(0) : '50';

  return new EmbedBuilder()
    .setColor(COLORS.ENTRY_SIGNAL)
    .setTitle(`🎯 ${token.symbol} — ENTRY SIGNAL`)
    .setDescription(
      `**Initial dump detected — potential entry zone**\n` +
      `Token dropped **${dropPct.toFixed(1)}%** from DEX listing price`
    )
    .addFields(
      { name: '📍 Listing Price', value: `$${listingPrice.toFixed(8)}`,   inline: true },
      { name: '💲 Current Price', value: `$${currentPrice.toFixed(8)}`,   inline: true },
      { name: '📉 Drop',          value: `${dropPct.toFixed(2)}%`,         inline: true },
      { name: '📈 Buy Pressure',  value: `${buyPct}% (${buyPressure} buys)`, inline: true },
      { name: '💧 Liquidity',     value: `$${liquidityUsd.toFixed(0)}`,   inline: true },
      { name: '📊 Vol 5m',        value: `$${vol5m.toFixed(0)}`,          inline: true },
    )
    .addFields(
      { name: '⚠️ Reminder', value: 'Not financial advice. Do your own research. Set a stop loss.', inline: false },
      { name: 'Mint', value: `\`${token.mint}\``, inline: false },
      { name: 'Links', value: [
        `[DexScreener](${dexUrl})`,
        `[Pump.fun](https://pump.fun/${token.mint})`,
        `[Solscan](https://solscan.io/token/${token.mint})`,
      ].join(' · ') }
    )
    .setTimestamp()
    .setFooter({ text: 'pump-scanner · entry signal · NFA' });
}

function buildStatsEmbed(registryStats, feedStats, graduatedCount) {
  const uptimeMin = (registryStats.uptimeMs / 60000).toFixed(0);
  return new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle('📊 Scanner Stats')
    .addFields(
      { name: 'Uptime',            value: `${uptimeMin}m`,                          inline: true },
      { name: 'Graduated (session)', value: `${registryStats.totalGraduated}`,      inline: true },
      { name: 'Enriched',          value: `${registryStats.totalEnriched}`,          inline: true },
      { name: 'Filtered Out',      value: `${registryStats.totalFiltered}`,          inline: true },
      { name: 'Signals Fired',     value: `${registryStats.totalSignals}`,           inline: true },
      { name: 'Trade Alerts',      value: `${registryStats.totalTradeAlerts}`,       inline: true },
      { name: 'Active Tracking',   value: `${registryStats.activeTokens}`,           inline: true },
      { name: 'PumpPortal',        value: feedStats.connected ? '🟢 Connected' : '🔴 Disconnected', inline: true },
      { name: 'Migrations Seen',   value: `${feedStats.totalMigrationsSeen}`,        inline: true },
      { name: 'All-time Graduated (DB)', value: `${graduatedCount}`,                 inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'pump-scanner · stats' });
}

// ── Public send functions ─────────────────────

export async function sendSignal(token, signal) {
  if (!discordReady) return;
  log.info(`Sending ${signal.level} to Discord: ${token.symbol}`);
  const channelId = signal.level === 'TRADE_ALERT'
    ? CONFIG.CHANNELS.TRADE_ALERTS
    : CONFIG.CHANNELS.SIGNALS;
  await send(channelId, { embeds: [buildSignalEmbed(token, signal)] });
}

/**
 * Send the initial graduation embed immediately — shows ⏳ pending for filter/DEX data.
 * Saves the message so it can be edited when enrichment + DEX data arrives.
 */
export async function sendGraduation(token) {
  if (!discordReady) return;
  log.info(`Sending graduation embed: ${token.symbol} [${token.mint.slice(0,8)}...]`);
  const msg = await send(CONFIG.CHANNELS.GRADUATED, {
    embeds: [buildGraduationEmbed(token, null, false)]
  });
  if (msg) {
    graduationMessages.set(token.mint, msg);
    log.info(`Graduation message saved for editing: ${token.symbol}`);
  }
}

/**
 * Edit the existing graduation embed when enrichment and/or DEX data is available.
 * Falls back to sending a new message if original wasn't captured.
 */
export async function updateGraduation(token, pair = null, enrichmentDone = false) {
  if (!discordReady) return;
  const existing = graduationMessages.get(token.mint);
  const embed = buildGraduationEmbed(token, pair, enrichmentDone);

  if (existing) {
    try {
      await existing.edit({ embeds: [embed] });
      log.info(`Graduation embed updated: ${token.symbol} (pair=${!!pair} enriched=${enrichmentDone})`);
      return;
    } catch (err) {
      log.warn(`Failed to edit graduation embed, sending new: ${err.message}`);
      graduationMessages.delete(token.mint);
    }
  }

  // Fallback — send fresh
  const msg = await send(CONFIG.CHANNELS.GRADUATED, { embeds: [embed] });
  if (msg) graduationMessages.set(token.mint, msg);
}

export async function sendEntrySignal(token, pair, dumpData) {
  if (!discordReady) return;
  log.info(`🎯 Sending ENTRY SIGNAL to Discord: ${token.symbol}`);
  await send(CONFIG.CHANNELS.TRADE_ALERTS, { embeds: [buildEntrySignalEmbed(token, pair, dumpData)] });
}

export async function sendStats(registryStats, feedStats, graduatedCount) {
  if (!discordReady) return;
  await send(CONFIG.CHANNELS.LOGS, { embeds: [buildStatsEmbed(registryStats, feedStats, graduatedCount)] });
}

// ── MCap / SOL formatters ──────────────────────
// We don't have a live SOL/USD feed, so we use a conservative $130 estimate.
// This is display-only — never used for trading decisions.
const SOL_USD_EST = 130;

function formatMcapSol(mcapSol) {
  if (!mcapSol || mcapSol === 0) return '—';
  const usd = mcapSol * SOL_USD_EST;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

// Also format a raw USD value
function formatUsd(usd) {
  if (!usd || usd === 0) return '—';
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

// ── Token live data fetcher ────────────────────
// Pulls name, symbol, mcap, image from pump.fun API + DexScreener
// pump.fun API works for ALL tokens including pre-graduation
// DexScreener works only post-graduation
const tokenMetaCache = new Map();
const TOKEN_META_TTL = 60_000; // 60s TTL — we want fresh data on each alert

async function fetchTokenLiveData(mint) {
  const cached = tokenMetaCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_META_TTL) return cached;

  const result = {
    name:       null,
    symbol:     null,
    image:      null,
    mcapUsd:    null,
    mcapSol:    null,
    priceUsd:   null,
    bondingPct: null,
    complete:   false,
    liqUsd:     null,
    vol1h:      null,
    dex:        null,
    dexUrl:     null,
    fetchedAt:  Date.now(),
  };

  // ── Try pump.fun API first (works pre and post grad) ──
  try {
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const d = await res.json();
      result.name       = d.name       || null;
      result.symbol     = d.symbol     || null;
      result.image      = d.image_uri  || null;
      result.mcapUsd    = d.usd_market_cap   || null;
      result.mcapSol    = d.market_cap       || null;
      result.complete   = !!d.complete;
      // Bonding curve % from virtual sol reserve
      if (d.virtual_sol_reserves && !d.complete) {
        result.bondingPct = Math.min(100, (d.virtual_sol_reserves / 85) * 100);
      } else if (d.complete) {
        result.bondingPct = 100;
      }
    }
  } catch { /* non-fatal */ }

  // ── Try DexScreener for post-grad live price/liquidity ──
  if (result.complete) {
    try {
      const res2 = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res2.ok) {
        const d2 = await res2.json();
        const pairs = (d2.pairs || []).filter(p => p.chainId === 'solana');
        if (pairs.length > 0) {
          pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
          const best = pairs[0];
          result.priceUsd = parseFloat(best.priceUsd || '0');
          result.liqUsd   = best.liquidity?.usd || 0;
          result.vol1h    = best.volume?.h1 || 0;
          result.mcapUsd  = best.marketCap || best.fdv || result.mcapUsd;
          result.dex      = best.dexId;
          result.dexUrl   = best.url || `https://dexscreener.com/solana/${best.pairAddress}`;
          if (!result.name)   result.name   = best.baseToken?.name;
          if (!result.symbol) result.symbol = best.baseToken?.symbol;
        }
      }
    } catch { /* non-fatal */ }
  }

  tokenMetaCache.set(mint, result);
  return result;
}

/**
 * Send a KOL CONVERGENCE alert — fires when 2+ KOLs bought same token.
 * Fetches LIVE token data (name, mcap, price) from pump.fun + DexScreener.
 */
export async function sendKOLConvergenceAlert(convergence, tokenName = null) {
  if (!discordReady) return;

  const { mint, uniqueKOLs, totalSol, mcapSol, bondingPct, windowMins } = convergence;

  // Fetch full live token data
  const live = await fetchTokenLiveData(mint);

  const displayName = live.name || tokenName || mint.slice(0, 8) + '...';
  const displaySymbol = live.symbol ? ` (${live.symbol})` : '';

  // MCap: use live USD from pump.fun API if available, else fall back to SOL estimate
  const mcapDisplay = live.mcapUsd
    ? formatUsd(live.mcapUsd)
    : formatMcapSol(live.mcapSol || mcapSol);

  // Price display
  const priceDisplay = live.priceUsd
    ? `$${live.priceUsd.toFixed(8)}`
    : live.mcapUsd
    ? `~$${(live.mcapUsd / 1_000_000_000).toFixed(10)}`
    : '—';

  // Bonding display — use live data if available
  const bondingDisplay = live.bondingPct != null
    ? `${live.bondingPct.toFixed(1)}%`
    : `${bondingPct.toFixed(1)}%`;

  const kolList = uniqueKOLs.map(k => `**${k.kolName}** (${k.solAmount.toFixed(3)} SOL)`).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xF59E0B)
    .setTitle(`🌟 ${uniqueKOLs.length} KOLs: ${displayName}${displaySymbol}`)
    .setDescription(`${uniqueKOLs.length} tracked KOLs bought the same token within **${windowMins}m**`);

  if (live.image) embed.setThumbnail(live.image);

  embed.addFields(
    { name: `KOL Buyers (${uniqueKOLs.length})`, value: kolList,           inline: false },
    { name: 'Total SOL In',  value: `${totalSol.toFixed(3)} SOL`,          inline: true  },
    { name: 'MCap',          value: mcapDisplay,                            inline: true  },
    { name: 'Bonding',       value: bondingDisplay,                         inline: true  },
  );

  // Add DEX data if graduated
  if (live.complete && live.liqUsd) {
    embed.addFields(
      { name: 'Price',      value: priceDisplay,              inline: true },
      { name: 'Liquidity',  value: formatUsd(live.liqUsd),    inline: true },
      { name: 'Vol 1h',     value: formatUsd(live.vol1h),     inline: true },
    );
  }

  embed.addFields({ name: 'Mint', value: `\`${mint}\``, inline: false });
  embed.addFields({
    name: 'Links',
    value: [
      `[Pump.fun](https://pump.fun/${mint})`,
      live.dexUrl ? `[DexScreener](${live.dexUrl})` : `[DexScreener](https://dexscreener.com/solana/${mint})`,
      `[Solscan](https://solscan.io/token/${mint})`,
    ].join(' · ')
  });

  embed.setTimestamp()
    .setFooter({ text: `pump-scanner · ${uniqueKOLs.length} kols converging` });

  log.info(`Sending KOL convergence alert: ${uniqueKOLs.length} KOLs on ${displayName}`);
  await send(CONFIG.CHANNELS.TRADE_ALERTS, { embeds: [embed] });
}

/**
 * Send a KOL holder alert — KOL found in graduated token's holder list.
 * Only fires for tokens that PASSED filters (worth watching).
 */
export async function sendKOLHolderAlert(kolMatches, token, pair = null) {
  if (!discordReady) return;

  // Get full live data
  const live = await fetchTokenLiveData(token.mint);

  const displayName = live.name
    || pair?.baseTokenName
    || (token.name !== 'Unknown' ? token.name : null)
    || token.symbol
    || token.mint.slice(0, 8);

  const displaySymbol = live.symbol || pair?.baseTokenSymbol || token.symbol;

  const mcapDisplay = live.mcapUsd
    ? formatUsd(live.mcapUsd)
    : formatMcapSol(token.marketCapSol);

  const kolList = kolMatches.map(k => `**${k.name}** (${k.pct || '?'}%)`).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x7C3AED)
    .setTitle(`\u{1F31F} ${kolMatches.length} KOL(s) in: ${displayName}${displaySymbol !== displayName ? ` (${displaySymbol})` : ''}`)
    .setDescription(`KOL wallet(s) found in holder list of newly graduated token`);

  if (live.image) embed.setThumbnail(live.image);

  embed.addFields(
    { name: `KOL Holders (${kolMatches.length})`, value: kolList,                      inline: false },
    { name: 'MCap',   value: mcapDisplay,                                               inline: true  },
    { name: 'Pool',   value: token.pool || '—',                                         inline: true  },
    { name: 'Filter', value: token.filterResult?.pass ? '\u2705 Passed' : '\u274C Filtered', inline: true  },
    { name: 'Mint',   value: '`' + token.mint + '`',                                    inline: false },
  );

  embed.addFields({
    name: 'Links',
    value: [
      `[Pump.fun](https://pump.fun/${token.mint})`,
      live.dexUrl ? `[DexScreener](${live.dexUrl})` : `[DexScreener](https://dexscreener.com/solana/${token.mint})`,
      `[Solscan](https://solscan.io/token/${token.mint})`,
    ].join(' · ')
  });

  embed.setTimestamp().setFooter({ text: 'pump-scanner \u00b7 kol holder' });

  log.info(`Sending KOL holder alert: ${kolMatches.map(k=>k.name).join(', ')} in ${displayName}`);
  await send(CONFIG.CHANNELS.TRADE_ALERTS, { embeds: [embed] });
}

/**
 * Send strategy analysis report to #logs channel
 */
export async function sendStrategyReport(report) {
  if (!discordReady) return;

  const embed = new EmbedBuilder()
    .setColor(0x6366F1) // indigo
    .setTitle(report.title)
    .addFields(
      { name: 'Base Win Rate',  value: report.baseWinRate,    inline: true },
      { name: 'Outcome Split',  value: report.outcomeLines,   inline: false },
      { name: 'Signal Impact (sorted by lift)', value: report.topSignals || 'Insufficient data', inline: false },
      { name: 'KOL Impact',     value: report.kolLines,        inline: false },
      { name: 'Recommendations', value: report.recLines,       inline: false },
    )
    .setTimestamp()
    .setFooter({ text: 'pump-scanner · strategy engine' });

  log.info('Sending strategy report to Discord');
  await send(CONFIG.CHANNELS.LOGS, { embeds: [embed] });
}