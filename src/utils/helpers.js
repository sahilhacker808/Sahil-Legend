'use strict';

const NodeCache = require('node-cache');
const config    = require('../config/config');

const logger = {
  info:    (...a) => console.log(`[INFO  ${new Date().toISOString()}]`, ...a),
  warn:    (...a) => console.warn(`[WARN  ${new Date().toISOString()}]`, ...a),
  error:   (...a) => console.error(`[ERROR ${new Date().toISOString()}]`, ...a),
  debug:   (...a) => process.env.DEBUG && console.log(`[DEBUG ${new Date().toISOString()}]`, ...a),
  success: (...a) => console.log(`[OK    ${new Date().toISOString()}]`, ...a),
};

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ─── Karachi Time ─────────────────────────────────────────
if (!global.getKarachiTime) {
  global.getKarachiTime = (d) =>
    (d || new Date()).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
}

// ─── Session Manager ──────────────────────────────────────
const activeBots = new Map();

function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = 'SAHIL-';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function validateSessionId(id) {
  return config.bot.sessionIdRegex.test(id);
}

function registerBot(sessionId, sock, mode = 'public') {
  activeBots.set(sessionId, { sock, mode, startedAt: Date.now(), messageCount: 0 });
  logger.success(`Bot registered: ${sessionId} | Mode: ${mode}`);
}

function getBotInstance(sessionId) {
  return activeBots.get(sessionId) || null;
}

function removeBot(sessionId) {
  const bot = activeBots.get(sessionId);
  if (bot?.sock) {
    try { if (typeof bot.sock.ws?.close === 'function') bot.sock.ws.close(); } catch (_) {}
  }
  activeBots.delete(sessionId);
  logger.warn(`Bot removed: ${sessionId}`);
}

function getAllActiveBots() {
  return Array.from(activeBots.entries()).map(([id, b]) => ({
    sessionId: id,
    mode: b.mode,
    startedAt: b.startedAt,
    uptimeSeconds: Math.floor((Date.now() - b.startedAt) / 1000),
    messageCount: b.messageCount || 0,
  }));
}

function incrementBotMessageCount(sessionId) {
  const bot = activeBots.get(sessionId);
  if (bot) bot.messageCount = (bot.messageCount || 0) + 1;
}

// ─── Helpers ──────────────────────────────────────────────
function isSuperAdmin(jid) {
  const num = jid.replace(/[^0-9]/g, '');
  return num === config.owner.number || num === config.owner.backup;
}

function isBotOwner(jid, ownerJid) {
  if (!jid || !ownerJid) return false;
  const n = j => j.replace(/:[0-9]+/, '').replace('@s.whatsapp.net', '').replace(/\D/g, '').replace(/^0+/, '');
  return n(jid) === n(ownerJid);
}

function getReactEmoji(text) {
  const t = (text || '').toLowerCase();
  for (const [, kw] of Object.entries(config.reactKeywords)) {
    if (kw.words.some(w => t.includes(w))) return kw.emoji;
  }
  return config.reactEmojis[Math.floor(Math.random() * config.reactEmojis.length)];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sanitizeInput(str) {
  return (str || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 2000);
}

function jidToNumber(jid) {
  return (jid || '').replace('@s.whatsapp.net', '').replace('@g.us', '');
}

function numberToJid(num) {
  return num.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

function getTimestamp() {
  return new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatBox(title, lines, emoji = '🤖') {
  const width = Math.max(title.length + 6, ...lines.map(l => l.length + 4), 28);
  const bar   = '═'.repeat(width);
  const pad   = s => `║ ${s}${' '.repeat(Math.max(0, width - s.length - 1))}║`;
  return [`╔${bar}╗`, pad(`${emoji} ${title}`), `╠${bar}╣`, ...lines.map(pad), `╚${bar}╝`].join('\n');
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

function isValidPhoneNumber(num) {
  return /^[0-9]{10,15}$/.test(num.replace(/[^0-9]/g, ''));
}

function truncate(str, max = 300) {
  return str && str.length > max ? str.slice(0, max) + '...' : str;
}

function safeEval(expr) {
  const raw = expr || '';
  if (/process|require|import|global|eval|Function|__/i.test(raw)) return null;
  const safe = raw.replace(/[^0-9+\-*/().%\s]/g, '');
  if (!safe.trim() || /\*\*/.test(safe)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + safe + ')')();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return result;
  } catch { return null; }
}

module.exports = {
  logger, cache,
  generateSessionId, validateSessionId,
  registerBot, getBotInstance, removeBot, getAllActiveBots, incrementBotMessageCount,
  isSuperAdmin, isBotOwner,
  getReactEmoji, sleep, sanitizeInput, safeEval,
  jidToNumber, numberToJid,
  getTimestamp, formatUptime, formatBox,
  isValidUrl, isValidPhoneNumber, truncate,
};
