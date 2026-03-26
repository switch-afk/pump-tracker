// ─────────────────────────────────────────────
//  utils/logger.js  —  unified logging system
//  levels: debug | info | warn | error
//  outputs: console (chalk-colored) + flat log file + Discord #logs channel
// ─────────────────────────────────────────────

import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[CONFIG.LOG_LEVEL] ?? 1;

// ── Log file setup ────────────────────────────
const LOG_DIR = path.join(CONFIG.DATA_DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const todayStr = () => new Date().toISOString().slice(0, 10);
const logFilePath = () => path.join(LOG_DIR, `pump-scanner-${todayStr()}.log`);

function writeToFile(line) {
  try {
    fs.appendFileSync(logFilePath(), line + '\n');
  } catch { /* non-fatal */ }
}

// ── Discord buffer (flushed every 10s) ────────
let discordBuffer = [];
let discordClient = null;   // set after Discord client is ready

export function setDiscordClientForLogger(client) {
  discordClient = client;
}

async function flushDiscordLogs() {
  if (!discordClient || discordBuffer.length === 0) return;
  const ch = discordClient.channels.cache.get(CONFIG.CHANNELS.LOGS);
  if (!ch) return;

  const batch = discordBuffer.splice(0, 20);  // max 20 lines per flush
  const msg = batch.join('\n').slice(0, 1990); // Discord 2000 char limit
  try {
    await ch.send({ content: `\`\`\`\n${msg}\n\`\`\`` });
  } catch { /* non-fatal */ }
}

setInterval(flushDiscordLogs, CONFIG.INTERVALS.LOG_FLUSH_MS);

// ── Core log function ─────────────────────────
function log(level, module, message, data = null) {
  if (LEVELS[level] < CURRENT_LEVEL) return;

  const ts = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  const plainLine = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${module}] ${message}${dataStr}`;

  // Console with chalk colors
  const tsColored   = chalk.gray(ts);
  const modColored  = chalk.cyan(`[${module}]`);
  let lvlColored;
  switch (level) {
    case 'debug': lvlColored = chalk.gray('[DEBUG]');   break;
    case 'info':  lvlColored = chalk.green('[INFO ]');  break;
    case 'warn':  lvlColored = chalk.yellow('[WARN ]'); break;
    case 'error': lvlColored = chalk.red('[ERROR]');    break;
    default:      lvlColored = chalk.white(`[${level.toUpperCase()}]`);
  }
  const msgColored = level === 'error' ? chalk.red(message) :
                     level === 'warn'  ? chalk.yellow(message) :
                     chalk.white(message);
  const dataColored = data ? chalk.gray(' ' + JSON.stringify(data)) : '';

  console.log(`${tsColored} ${lvlColored} ${modColored} ${msgColored}${dataColored}`);

  // File
  writeToFile(plainLine);

  // Discord buffer (warn + error only to avoid spam)
  if (level === 'warn' || level === 'error') {
    const icon = level === 'error' ? '🔴' : '🟡';
    discordBuffer.push(`${icon} [${module}] ${message}${dataStr}`);
  }
}

// ── Named module logger factory ───────────────
export function createLogger(module) {
  return {
    debug: (msg, data) => log('debug', module, msg, data),
    info:  (msg, data) => log('info',  module, msg, data),
    warn:  (msg, data) => log('warn',  module, msg, data),
    error: (msg, data) => log('error', module, msg, data),
    // Separator for visual clarity in logs
    section: (title) => {
      const line = '─'.repeat(60);
      const ts = new Date().toISOString();
      const plain = `[${ts}] [─────] [${module}] ${line}\n[${ts}] [─────] [${module}]  ${title}\n[${ts}] [─────] [${module}] ${line}`;
      console.log(chalk.blue(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`));
      writeToFile(plain);
    }
  };
}

export default createLogger;
