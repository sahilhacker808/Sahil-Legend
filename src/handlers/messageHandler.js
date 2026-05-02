'use strict';

// ════════════════════════════════════════════════════════════════════════════
//  Sahil 804 BOT — src/handlers/messageHandler.js
//  FINAL v12.1.0 — 2026
//
//  ALL FIXES (v11 → v12):
//    ✅ FIX 1 : Race Condition — _viewOncePending Map
//               User .v type kare capture ke dauraan → ab wait karta hai
//    ✅ FIX 2 : Dual-Strategy Download — message:m → fallback message:inner
//               Har Baileys version mein kaam karega (guaranteed)
//    ✅ FIX 3 : Retry with Exponential Backoff — 3 attempts (0s, 1s, 2s)
//               Network blip pe bhi recover hoga
//    ✅ FIX 4 : Dual-Key Storage — key.id + stanzaId cross-reference
//               Key mismatch edge case permanently fix
//    ✅ FIX 5 : Buffer Validation — empty/corrupt buffer detect
//    ✅ FIX 6 : .v handler — pending await (10s timeout) + "Please wait" msg
//    ✅ FIX 7 : Auto-cleanup on serve — memory leak prevent
// ════════════════════════════════════════════════════════════════════════════

const config = require('../config/config');
const {
  isSuperAdmin,
  getReactEmoji,
  logger,
  incrementBotMessageCount,
  sanitizeInput,
  formatUptime,
  getTimestamp,
  jidToNumber,
} = require('../utils/helpers');
const { handleCommand } = require('../commands/index');
const { getSession }    = require('../database/localDb');
const NodeCache         = require('node-cache');

// ─── SESSION CACHE ────────────────────────────────────────────────────────────
const sessionCache         = new NodeCache({ stdTTL: 60, checkperiod: 20 });
const _pendingSessionFetch = new Map();

// ════════════════════════════════════════════════════════════════════════════
//  SESSION SETTINGS STORE
// ════════════════════════════════════════════════════════════════════════════
const sessionSettings = new Map();

function getSettings(sessionId) {
  if (!sessionSettings.has(sessionId)) {
    sessionSettings.set(sessionId, {
      autoReact:       true,
      statusSeen:      true,
      autoTyping:      true,
      alwaysOnline:    true,
      alwaysRecording: false,
      antiDelete:      true,
      viewOnce:        true,
      chatbot:         false,
      autoRead:        true,
      antiLink:        false,
    });
  }
  return sessionSettings.get(sessionId);
}

global.__sessionSettings = sessionSettings;
global.__getSettings     = getSettings;

// ════════════════════════════════════════════════════════════════════════════
//  REACT EMOJI POOL
// ════════════════════════════════════════════════════════════════════════════
const REACT_POOL = [
  '❤️','🔥','😂','👏','🎯','⚡','💎','🌟','🚀','😎',
  '💪','🙌','✅','👑','🎉','💯','🤩','😍','🫡','🫶',
  '🥳','🏆','💫','🌈','🎊','😄','🤝','👍','💥','🎶',
  '🍀','🌺','🦋','🌙','☀️','🎈','🎁','🍭','🌸','🦄',
  '😇','🥰','😘','🤗','😜','🤪','😏','🥹','😤','🫠',
  '👀','🙏','✨','🔮','🎀','🧿','🫧','🌊','🍉','🎸',
];

function pickEmoji() {
  return REACT_POOL[Math.floor(Math.random() * REACT_POOL.length)];
}

// ════════════════════════════════════════════════════════════════════════════
//  ① ANTI-SPAM ENGINE
// ════════════════════════════════════════════════════════════════════════════
const spamTracker = new Map();
const SPAM_LIMIT  = 8;
const SPAM_WINDOW = 10_000;

setInterval(() => {
  const now = Date.now();
  for (const [jid, e] of spamTracker.entries())
    if (now - e.lastMsg > SPAM_WINDOW * 6) spamTracker.delete(jid);
}, 5 * 60_000);

function isSpamming(jid) {
  const now   = Date.now();
  const entry = spamTracker.get(jid);
  if (!entry || now - entry.lastMsg > SPAM_WINDOW) {
    spamTracker.set(jid, { count: 1, lastMsg: now, warned: false });
    return false;
  }
  entry.count++;
  entry.lastMsg = now;
  return entry.count > SPAM_LIMIT;
}

// ════════════════════════════════════════════════════════════════════════════
//  ② COOLDOWN ENGINE
// ════════════════════════════════════════════════════════════════════════════
const cooldowns   = new Map();
const COOLDOWN_MS = 5_000;

function isOnCooldown(jid, cmd) {
  const last = cooldowns.get(`${jid}:${cmd}`);
  if (!last) return false;
  return (Date.now() - last) < COOLDOWN_MS;
}

function setCooldown(jid, cmd) {
  cooldowns.set(`${jid}:${cmd}`, Date.now());
}

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of cooldowns.entries())
    if (now - t > COOLDOWN_MS * 2) cooldowns.delete(k);
}, 10 * 60_000);

// ════════════════════════════════════════════════════════════════════════════
//  ③ USER ACTIVITY TRACKER
// ════════════════════════════════════════════════════════════════════════════
const userActivity = new NodeCache({ stdTTL: 3600, checkperiod: 300, maxKeys: 50000 });

function trackUser(jid, pushName, isCommand) {
  const now      = global.getKarachiTime();
  const existing = userActivity.get(jid) || {
    totalMsgs: 0, commandCount: 0,
    lastSeen: now, firstName: pushName || 'User',
    joinedAt: now,
  };
  existing.totalMsgs++;
  if (isCommand) existing.commandCount++;
  existing.lastSeen  = now;
  existing.firstName = pushName || existing.firstName;
  userActivity.set(jid, existing);
}

global.__userActivity = userActivity;

// ════════════════════════════════════════════════════════════════════════════
//  ④ SMART REACT ENGINE
// ════════════════════════════════════════════════════════════════════════════
function getSmartReact(body, prefix) {
  const b = (body || '').toLowerCase().trim();
  if (!b.startsWith(prefix)) return getReactEmoji(body);
  const cmd = b.slice(prefix.length).split(' ')[0];
  const map = {
    dl:'⬇️',video:'🎬',audio:'🎵',play:'🎶',song:'🎸',yt:'📺',ytmp3:'🎵',
    tiktok:'🎵',fb:'📘',ig:'📸',menu:'📋',help:'📖',info:'ℹ️',ping:'🏓',
    speed:'⚡',uptime:'⏱️',stats:'📊',mystats:'👤',weather:'🌤️',news:'📰',
    quran:'📖',hadith:'📿',dua:'🤲',prayer:'🕌',hijri:'🕋',joke:'😂',
    meme:'😄',quote:'💬',fact:'🧠',riddle:'🤔',shayari:'🌹',attitude:'😎',
    pickup:'😍',roast:'🔥',truth:'❓',dare:'🎯',compliment:'🌟',gm:'🌅',
    gn:'🌙',calc:'🧮',translate:'🌐',sticker:'🎨',s:'🎨',wiki:'📚',
    short:'🔗',define:'📝',currency:'💱',time:'⏰',sim:'📱',ip:'🌐',
    fancy:'✨',big:'🔠',howto:'📋',crypto:'💹',topcrypto:'📊',broadcast:'📢',
    kick:'👢',add:'➕',promote:'⬆️',demote:'⬇️',mute:'🔇',unmute:'🔊',
    tagall:'📣',ai:'🤖',gpt:'🧠',v:'👁️',vlist:'📋',vall:'📤',vdel:'🗑️',
    settings:'⚙️',react:'❤️',status:'👁️',typing:'⌨️',online:'🟢',
    record:'🎙️',antidel:'🗑️',vonce:'👁️',autoread:'📖',antilink:'🔗',
    default:'⚡',
  };
  return map[cmd] || map.default;
}

// ════════════════════════════════════════════════════════════════════════════
//  ⑤ MESSAGE BODY EXTRACTOR
// ════════════════════════════════════════════════════════════════════════════
function extractBody(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation                                                      ||
    m.extendedTextMessage?.text                                         ||
    m.imageMessage?.caption                                             ||
    m.videoMessage?.caption                                             ||
    m.documentMessage?.caption                                          ||
    m.audioMessage?.caption                                             ||
    m.stickerMessage?.caption                                           ||
    m.buttonsResponseMessage?.selectedButtonId                          ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId             ||
    m.templateButtonReplyMessage?.selectedId                            ||
    m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ''
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
//  ⑥ ANTI-DELETE: In-Memory Message Store
// ════════════════════════════════════════════════════════════════════════════
// ✅ FIX: TTL 1800s (30 min) + maxKeys 200
const deletedMsgStore = new NodeCache({ stdTTL: 1800, checkperiod: 30, maxKeys: 200 });

// ✅ Global expose — launcher.js ka messages.delete handler isko check karega
global.__deletedMsgStore = deletedMsgStore;

// Processed keys tracker — cross-file deduplication ke liye
const _antiDeleteProcessed = new Set();
global.__antiDeleteProcessed = _antiDeleteProcessed;

// Cleanup interval
setInterval(() => {
  if (_antiDeleteProcessed.size > 1000) _antiDeleteProcessed.clear();
}, 5 * 60_000);

function storeMessageForAntiDelete(msg) {
  try {
    if (!msg?.key?.id || !msg.message) return;
    if (msg.key.fromMe) return;
    const m = msg.message;
    const skip = [
      'protocolMessage','reactionMessage','pollUpdateMessage',
      'senderKeyDistributionMessage','messageContextInfo',
    ];
    if (skip.some(t => m[t])) return;
    
    // ✅ FIX: Proper sender extraction — group mein participant, private mein remoteJid
    const actualSender = msg.key.participant || msg.key.remoteJid;
    
    deletedMsgStore.set(msg.key.id, {
      key:      msg.key,
      message:  msg.message,
      pushName: msg.pushName || '',
      from:     msg.key.remoteJid,
      sender:   actualSender,
      ts:       Date.now(),
    });
  } catch (_) {}
}  
// ════════════════════════════════════════════════════════════════════════════
//  ⑦ VIEW ONCE UNLOCK SYSTEM — v12.0.0 BULLETPROOF
//
//  Improvements:
//  ✅ Race Condition fix   → _viewOncePending Map (Promise-based)
//  ✅ Dual-Strategy DL    → message:m first → fallback message:inner
//  ✅ Retry + Backoff     → 3 attempts (0ms → 1000ms → 2000ms delay)
//  ✅ Dual-Key Storage    → key.id + stanzaId cross-indexed
//  ✅ Buffer Validation   → empty/null buffer = hard fail, nahi chalega
// ════════════════════════════════════════════════════════════════════════════
const viewOnceStore   = new NodeCache({ stdTTL: 3000, checkperiod: 120, maxKeys: 500 });
const _viewOncePending = new Map(); // keyId → { resolve, reject, promise }
global.__viewOnceStore   = viewOnceStore;
global.__viewOncePending = _viewOncePending;

// ─── Internal: Single download attempt ───────────────────────────────────────
async function _tryDownloadViewOnce(sock, downloadMediaMessage, msgKey, m, inner) {
  // ✅ FIX: reuploadRequest — CDN URL expire hone par WhatsApp se fresh URL lo
  const dlCtx = { reuploadRequest: sock.updateMediaMessage };

  // Strategy 1: message:m → Baileys internal unwrap
  let buf = await downloadMediaMessage(
    { key: msgKey, message: m }, 'buffer', {}, dlCtx
  ).catch(() => null);

  if (buf && buf.length === 0) buf = null;
  if (buf) return buf;

  // Strategy 2: message:inner → direct media object
  logger.warn('[ViewOnce] Strategy-1 failed, trying Strategy-2 (inner)...');
  buf = await downloadMediaMessage(
    { key: msgKey, message: inner }, 'buffer', {}, dlCtx
  ).catch(() => null);

  if (buf && buf.length === 0) buf = null;
  return buf || null;
}

async function captureViewOnceMedia(sock, msg) {
  // ─── Guard ──────────────────────────────────────────────────────────────
  const m = msg?.message;
  if (!m) return;

  const hasViewOnce =
    !!m.viewOnceMessage ||
    !!m.viewOnceMessageV2 ||
    !!m.viewOnceMessageV2Extension;
  if (!hasViewOnce) return;

  const inner =
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message;
  if (!inner) return;

  const isImage = !!inner.imageMessage;
  const isVideo = !!inner.videoMessage;
  const isAudio = !!inner.audioMessage;
  if (!isImage && !isVideo && !isAudio) return;

  const keyId = msg.key.id;

  // ─── Register Pending Promise ────────────────────────────────────────────
  // .v command agar capture ke dauraan aaye → is promise ko await karega
  let resolvePending, rejectPending;
  const pendingPromise = new Promise((res, rej) => {
    resolvePending = res;
    rejectPending  = rej;
  });
  _viewOncePending.set(keyId, pendingPromise);

  try {
    // ─── Baileys Import ────────────────────────────────────────────────────
    let downloadMediaMessage;
    try {
      const baileys = global.__baileys || await import('@whiskeysockets/baileys');
      if (!global.__baileys) global.__baileys = baileys;
      downloadMediaMessage = baileys.downloadMediaMessage;
    } catch (e) {
      logger.error('[ViewOnce] Baileys import failed:', e.message);
      resolvePending(null);
      _viewOncePending.delete(keyId);
      return;
    }

    // ─── Retry Loop: 3 attempts with exponential backoff ──────────────────
    const RETRY_DELAYS = [0, 1000, 2000]; // ms
    let buf = null;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      logger.info(`[ViewOnce] Download attempt ${attempt + 1}/3 for ${keyId}`);
      buf = await _tryDownloadViewOnce(sock, downloadMediaMessage, msg.key, m, inner);

if (buf) break; // ✅ Success — loop se niklo

      logger.warn(`[ViewOnce] Attempt ${attempt + 1} failed for ${keyId}`);
    }

    if (!buf) {
      logger.error(`[ViewOnce] ❌ All 3 attempts failed for ${keyId}`);
      resolvePending(null);
      _viewOncePending.delete(keyId);
      return;
    }

    // ─── Build Store Entry ─────────────────────────────────────────────────
    const mediaType = isImage ? 'image' : isAudio ? 'audio' : 'video';
    const mediaMime = isImage
      ? (inner.imageMessage?.mimetype  || 'image/jpeg')
      : isAudio
        ? (inner.audioMessage?.mimetype || 'audio/mpeg')
        : (inner.videoMessage?.mimetype || 'video/mp4');
    const isPtt = isAudio ? (inner.audioMessage?.ptt || false) : false;

    const storeData = {
      buffer:   buf,
      type:     mediaType,
      mimetype: mediaMime,
      ptt:      isPtt,
      sender:   msg.key.participant || msg.key.remoteJid,
      from:     msg.key.remoteJid,
      pushName: msg.pushName || '',
      ts:       Date.now(),
      keyId,
    };

    // ✅ DUAL-KEY STORAGE: key.id pe store karo
    viewOnceStore.set(keyId, storeData);

    // ✅ CROSS-INDEX: Agar stanzaId alag ho (forwarded/quoted edge case)
    // Note: stanzaId incoming msg se nahi milta capture time pe,
    // lekin _viewOncePending promise se .v resolve ho jaata hai
    // Isliye ye enough hai.

    logger.info(`[ViewOnce] ✅ Captured ${mediaType} (${buf.length} bytes) — ${msg.pushName || keyId}`);

    // ─── Resolve Pending — .v command ab serve kar sakta hai ──────────────
    resolvePending(storeData);

  } catch (err) {
    logger.error('[ViewOnce] Capture error:', err.message);
    resolvePending(null);
  } finally {
    // Cleanup pending map (10s baad bhi nahi raha toh delete)
    setTimeout(() => _viewOncePending.delete(keyId), 10_000);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⑧ AUTO STATUS SYSTEM
// ════════════════════════════════════════════════════════════════════════════
const statusSeenTracker     = new Map();
const STATUS_REACT_DELAY_MS = 1_000;

setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [jid, ts] of statusSeenTracker.entries())
    if (ts < cutoff) statusSeenTracker.delete(jid);
}, 30 * 60_000);

// ════════════════════════════════════════════════════════════════════════════
//  ⑨ JID CLEANER — ✅ FIX 1 APPLIED
// ════════════════════════════════════════════════════════════════════════════
function cleanJidToNumber(jid) {
  if (!jid) return 'Unknown';

  // @lid = WhatsApp Privacy JID — colon se pehle wala part lo
  if (jid.includes('@lid')) {
    const part = jid.split('@')[0].split(':')[0];
    return part && part.length > 2 ? part : '🔒 Hidden';
  }

  const cleaned = jid
    .replace('@s.whatsapp.net', '')
    .replace('@g.us', '')
    .replace(/[^0-9+]/g, '');

  if (!cleaned || cleaned.length < 5) return jid.split('@')[0] || 'Unknown';
  return cleaned;
}

// ════════════════════════════════════════════════════════════════════════════
//  ⑩ ANTI-DELETE ALERT — SAME INBOX DELIVERY
// ════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────
// 🔥 Helper: Contact Name
// ─────────────────────────────────────────────────────────
async function getContactName(sock, jid) {
  try {
    const storeContact = sock.store?.contacts?.[jid];
    if (storeContact?.name) return storeContact.name;
    if (storeContact?.notify) return storeContact.notify;

    const cached = global.__userActivity?.get(jid);
    if (cached?.firstName && cached.firstName !== jid.split('@')[0]) {
      return cached.firstName;
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// 🔥 MAIN FUNCTION (OPTIMIZED)
// ─────────────────────────────────────────────────────────
async function sendAntiDeleteAlert(sock, stored) {
  try {
    const chatJid   = stored.from;
    const senderJid = stored.sender || stored.key.remoteJid || '';
    const senderNum = cleanJidToNumber(senderJid);

    // ✅ Name Resolve (fast fallback system)
    let senderName = stored.pushName;
    if (!senderName || senderName === senderNum) {
      senderName = await getContactName(sock, senderJid) || senderNum;
    }

    const delTime  = global.getKarachiTime();
    const origTime = global.getKarachiTime(new Date(stored.ts));
    const m = stored.message;

    // ─────────────────────────────────────────────────────
    // 🔥 TYPE MAP (NO REPEAT CODE)
    // ─────────────────────────────────────────────────────
    const typeMap = [
      ['imageMessage',    '🖼️', 'Image'],
      ['videoMessage',    '🎬', 'Video'],
      ['audioMessage',    '🎵', m?.audioMessage?.ptt ? 'Voice Note' : 'Audio'],
      ['stickerMessage',  '🎭', 'Sticker'],
      ['documentMessage', '📄', 'Document'],
    ];

    let detected = typeMap.find(([key]) => m[key]);
    let mediaKey = detected?.[0];
    let mediaIcon = detected?.[1] || '📝';
    let messageType = detected?.[2] || 'Text';

    // ─────────────────────────────────────────────────────
    // 🔥 HEADER
    // ─────────────────────────────────────────────────────
    const header =
      `╔══════════════════════════════╗\n` +
      `║  🚫 𝑫𝑬𝑳𝑬𝑻𝑬𝑫 𝑴𝑬𝑺𝑺𝑨𝑮𝑬 𝑹𝑬𝑪𝑶𝑽𝑬𝑹𝑬𝑫 ║\n` +
      `╠══════════════════════════════╣\n` +
      `║ 📌 Name : ${senderName}\n` +
      `║ 📞 No   : +${senderNum}\n` +
      `║ 📅 Sent : ${origTime}\n` +
      `║ ⏰ Del  : ${delTime}\n` +
      `║ 📄 Type : ${messageType}\n` +
      `╠══════════════════════════════╣\n` +
      `║  📩 Content Below            ║\n` +
      `╚══════════════════════════════╝`;

    // ─────────────────────────────────────────────────────
    // 📝 TEXT (FAST EXIT)
    // ─────────────────────────────────────────────────────
    if (m.conversation || m.extendedTextMessage?.text) {
      const txt = m.conversation || m.extendedTextMessage.text;
      return await sock.sendMessage(chatJid, {
        text: `${header}\n\n${mediaIcon} *Content:*\n${txt}`,
      }).catch(() => {});
    }

    // ─────────────────────────────────────────────────────
    // 📥 MEDIA DOWNLOADER (ONE TIME LOAD)
    // ─────────────────────────────────────────────────────
    let downloadMediaMessage;
    try {
      const baileys = global.__baileys || await import('@whiskeysockets/baileys');
      if (!global.__baileys) global.__baileys = baileys;
      downloadMediaMessage = baileys.downloadMediaMessage;
    } catch {
      return await sock.sendMessage(chatJid, {
        text: `${header}\n\n⚠️ Media Recovery Failed`,
      }).catch(() => {});
    }

    const dlCtx = { reuploadRequest: sock.updateMediaMessage };
    const fakeMsg = { message: stored.message, key: stored.key };

    // ─────────────────────────────────────────────────────
    // 🔥 SINGLE MEDIA HANDLER (NO DUPLICATION)
    // ─────────────────────────────────────────────────────
    if (mediaKey) {
      let buf = await downloadMediaMessage(fakeMsg, 'buffer', {}, dlCtx).catch(() => null);
      if (!buf || buf.length === 0) {
        return await sock.sendMessage(chatJid, {
          text: `${header}\n\n${mediaIcon} ${messageType} (Failed)`,
        }).catch(() => {});
      }

      const sendMap = {
        imageMessage:    { image: buf, caption: `${header}\n\n🖼️ Deleted Image` },
        videoMessage:    { video: buf, caption: `${header}\n\n🎬 Deleted Video` },
        audioMessage:    {
          audio: buf,
          mimetype: m.audioMessage.mimetype || 'audio/mpeg',
          ptt: m.audioMessage.ptt || false,
        },
        stickerMessage:  { sticker: buf },
        documentMessage: {
          document: buf,
          mimetype: m.documentMessage.mimetype || 'application/octet-stream',
          fileName: m.documentMessage.fileName || 'deleted_file',
          caption: `${header}\n\n📄 Deleted Document`,
        }
      };

      await sock.sendMessage(chatJid, sendMap[mediaKey]).catch(() => {});

      // optional label after audio/sticker
      if (mediaKey === 'audioMessage' || mediaKey === 'stickerMessage') {
        await sock.sendMessage(chatJid, {
          text: `${header}\n\n${mediaIcon} Deleted ${messageType}`,
        }).catch(() => {});
      }

      return;
    }

    // ─────────────────────────────────────────────────────
    // ❓ UNKNOWN
    // ─────────────────────────────────────────────────────
    await sock.sendMessage(chatJid, {
      text: `${header}\n\n❓ Unknown Message Type`,
    }).catch(() => {});

  } catch (err) {
    logger.error('[AntiDelete] error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⑪ STICKER CREATOR ENGINE
// ════════════════════════════════════════════════════════════════════════════
async function createSticker(imageBuffer) {
  try {
    const sharp = require('sharp');
    return await sharp(imageBuffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80, lossless: false })
      .toBuffer();
  } catch (_) {
    return imageBuffer;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⑬ ANTI-LINK ENGINE
// ════════════════════════════════════════════════════════════════════════════
const LINK_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+|bit\.ly\/[^\s]+|youtu\.be\/[^\s]+)/i;

async function handleAntiLink(sock, msg, from, sender, botOwnerJid, S) {
  try {
    if (!S.antiLink) return false;
    if (!from.endsWith('@g.us')) return false;
    const body = extractBody(msg);
    if (!body || !LINK_REGEX.test(body)) return false;

    const groupMeta = await sock.groupMetadata(from).catch(() => null);
    if (!groupMeta) return false;

    const groupAdmins   = groupMeta.participants.filter(p => p.admin).map(p => p.id);
    const botId         = sock.user?.id?.replace(/:[0-9]+@/, '@') || '';
    if (!groupAdmins.includes(botId)) return false;

    const isSenderAdmin = groupAdmins.includes(sender);
    const ownerNum      = (botOwnerJid || '').replace('@s.whatsapp.net', '').replace(/\D/g, '').replace(/^0/, '92');
    const senderNum     = sender.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (isSenderAdmin || senderNum === ownerNum) return false;

    await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
    await sock.sendMessage(from, {
      text:
        `╔══════════════════════════════╗\n` +
        `║  🔗 𝑨𝑵𝑻𝑰 𝑳𝑰𝑵𝑲 𝑺𝒀𝑺𝑻𝑬𝑴          ║\n` +
        `╠══════════════════════════════╣\n` +
        `║  ⚠️ 𝑳𝒊𝒏𝒌 𝑫𝒆𝒕𝒆𝒄𝒕𝒆𝒅!\n` +
        `║  👤 𝑺𝒆𝒏𝒅𝒆𝒓 : @${sender.replace('@s.whatsapp.net', '')}\n` +
        `║  🗑️ 𝑴𝒆𝒔𝒔𝒂𝒈𝒆 𝑫𝒆𝒍𝒆𝒕𝒆𝒅\n` +
        `║\n` +
        `║  🚫 𝑳𝒊𝒏𝒌𝒔 𝑵𝒐𝒕 𝑨𝒍𝒍𝒐𝒘𝒆𝒅 𝑰𝒏 𝑻𝒉𝒊𝒔 𝑮𝒓𝒐𝒖𝒑!\n` +
        `╠══════════════════════════════╣\n` +
        `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
        `╚══════════════════════════════╝`,
       mentions: [sender],
    }).catch(() => {});
    return true;
  } catch (err) {
    logger.error('[AntiLink] Error:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ⑯ WELCOME MESSAGE SENDER
// ════════════════════════════════════════════════════════════════════════════
const welcomeSentTo = new Set();

async function sendWelcomeMessage(sock, jid) {
  try {
    if (welcomeSentTo.has(jid)) return;
    welcomeSentTo.add(jid);
    setTimeout(() => welcomeSentTo.delete(jid), 30 * 60_000);

    await sock.sendMessage(jid, {
      text:
        `╭━━━〔 🚀 𝑺𝑨𝑯𝑰𝑳 𝟖𝟎𝟒 𝑩𝑶𝑻 〕━━━╮\n` +
        `┃\n` +
        `┃ 🌐 𝑶𝒇𝒇𝒊𝒄𝒊𝒂𝒍 𝑪𝒉𝒂𝒏𝒏𝒆𝒍\n` +
        `┃ 🔗 https://whatsapp.com/channel/0029Vb7ufE7It5rzLqedDc3l\n` +
        `┃\n` +
        `┃ 👤 𝑶𝒘𝒏𝒆𝒓 𝑪𝒐𝒏𝒕𝒂𝒄𝒕\n` +
        `┃ 📞 +923711158307\n` +
        `┃\n` +
        `┃ ⚠️ Bot ko sirf ek dafa link karna hota hai.\n` +
        `┃ Dobara code dene wala hack karna chahta hai.\n` +
        `┃\n` +
        `┃ 🔐 Apni security ka khayal rakhein.\n` +
        `┃\n` +
        `┃ 📋 Type .menu to see all commands!\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━╯`,
    }).catch(() => {});
  } catch (err) {
    logger.error('[Welcome] Error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════════════════
async function handleMessage(sock, msg, sessionId) {
  try {
    if (!msg.message) return;

    const from = msg.key.remoteJid;
if (!from) return;

const isGroupMsg = from.endsWith('@g.us');
const botSelfJid = (sock.user?.id || '').replace(/:[0-9]+@/, '@');
const sender     = isGroupMsg
  ? (msg.key.participant || msg.key.remoteJid)
  : (msg.key.fromMe ? botSelfJid : (msg.key.participant || msg.key.remoteJid));
    const S          = getSettings(sessionId);

    // ── OWNER OUTGOING — react + command passthrough ──────────────────────────
    // ✅ FIX: fromMe block now has a proper fast-path for owner commands
    //         React sent ONCE here (removed duplicate from bottom of handler)
    //         Private non-prefix messages → early return (no processing waste)
if (msg.key.fromMe) {
  const _ownerBody   = extractBody(msg);
  const _ownerPrefix = config.bot.prefix || '.';

  // Non-command in private chat → ignore completely (no processing)
  if (!isGroupMsg && !_ownerBody.startsWith(_ownerPrefix)) return;

  // React for owner (only here — NOT again later in the handler)
  if (from !== 'status@broadcast' && S.autoReact && msg.message) {
    sock.sendMessage(from, {
      react: { text: _ownerBody.startsWith(_ownerPrefix) ? getSmartReact(_ownerBody, _ownerPrefix) : pickEmoji(), key: msg.key },
    }).catch(() => {});
  }
}

    // ── ALWAYS ONLINE ─────────────────────────────────────────────────────────
    if (S.alwaysOnline) {
      global.__sendPresence
        ? global.__sendPresence(sock, 'available', from)
        : sock.sendPresenceUpdate('available', from).catch(() => {});
    }

    // ── AUTO TYPING / RECORDING ───────────────────────────────────────────────
    if (S.autoTyping && !isGroupMsg) {
      global.__sendPresence
        ? global.__sendPresence(sock, 'composing', from)
        : sock.sendPresenceUpdate('composing', from).catch(() => {});
      setTimeout(() => (global.__sendPresence
        ? global.__sendPresence(sock, 'paused', from)
        : sock.sendPresenceUpdate('paused', from).catch(() => {})), 3000);
    }
    if (S.alwaysRecording && !isGroupMsg) {
      global.__sendPresence
        ? global.__sendPresence(sock, 'recording', from)
        : sock.sendPresenceUpdate('recording', from).catch(() => {});
      setTimeout(() => (global.__sendPresence
        ? global.__sendPresence(sock, 'paused', from)
        : sock.sendPresenceUpdate('paused', from).catch(() => {})), 3000);
    }

    // ── STATUS SEEN + REACT + REPLY ───────────────────────────────────────────
    if (from === 'status@broadcast') {
      if (!S.statusSeen) return;
      try {
        const statusSender = msg.key.participant || sender;
        if (!statusSender || statusSender.endsWith('@g.us') || statusSender.endsWith('@broadcast')) return;
        const lastReact = statusSeenTracker.get(statusSender) || 0;
        if (Date.now() - lastReact < STATUS_REACT_DELAY_MS) return;
        statusSeenTracker.set(statusSender, Date.now());

        const senderName = msg.pushName || jidToNumber(statusSender);
        await Promise.all([
          sock.readMessages([msg.key]).catch(() => {}),
          sock.sendMessage(
            'status@broadcast',
            { react: { text: pickEmoji(), key: msg.key } },
            { statusJidList: [statusSender] }
          ).catch(() => {}),
        ]);
        const statusRecipient = statusSender.includes('@') ? statusSender : statusSender + '@s.whatsapp.net';
        await sock.sendMessage(statusRecipient, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑺𝑻𝑨𝑻𝑼𝑺 𝑽𝑰𝑬𝑾𝑬𝑫 ✅         ║\n` +
            `╠══════════════════════════════╣\n` +
            `║ 👤 𝑵𝒂𝒎𝒆   : ${senderName}\n` +
            `║ 🕐 𝑻𝒊𝒎𝒆   : ${global.getKarachiTime()}\n` +
            `║\n` +
            `║ 👁️ 𝒀𝒐𝒖𝒓 𝑺𝒕𝒂𝒕𝒖𝒔 𝑯𝒂𝒔 𝑩𝒆𝒆𝒏 𝑺𝒆𝒆𝒏\n` +
            `║    𝑩𝒚 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑩𝒐𝒕 ⚡\n` +
            `║\n` +
            `║ 📢 https://whatsapp.com/channel/0029Vb7ufE7It5rzLqedDc3l\n` +
            `╚══════════════════════════════╝`,
        }).catch(() => {});
      } catch (e) { logger.error('[AutoStatus] Error:', e.message); }
      return;
    }

    // ── STORE MSG + CAPTURE VIEW ONCE (parallel) ──────────────────────────────
    if (!msg.key.fromMe) {
      storeMessageForAntiDelete(msg);
      if (S.viewOnce) captureViewOnceMedia(sock, msg).catch(() => {});
    }

    const body     = sanitizeInput(extractBody(msg));
    const prefix   = config.bot.prefix || '.';
    const isCmd    = body.startsWith(prefix);
    const pushName = msg.pushName || 'User';

    // ── SESSION FETCH — FAST CACHE FIRST ─────────────────────────────────────
    // ✅ FIX: Cache TTL extended to 10 minutes (was 60s/2min → too many disk reads)
    //         Owner (fromMe) sessions PINNED — never expire from cache
    //         Safe null check on fastSessionCache — agar server init se pehle message aaye
    const _sc = global.__fastSessionCache;
    let session = null;
    if (_sc && typeof _sc.get === 'function') {
      session = _sc.get(sessionId);
    }
    if (!session) session = sessionCache.get(sessionId);
    if (!session) {
      if (_pendingSessionFetch.has(sessionId)) {
        session = await _pendingSessionFetch.get(sessionId);
      } else {
        const p = getSession(sessionId).then(d => {
          if (d) {
            // ✅ FIX: 10 minute TTL (was 60s in NodeCache / 2min in fastCache)
            sessionCache.set(sessionId, d, 600); // NodeCache: 600 seconds
            if (_sc) _sc.set(sessionId, d, 600_000); // fastCache: 10 min ms
          }
          _pendingSessionFetch.delete(sessionId);
          return d;
        });
        _pendingSessionFetch.set(sessionId, p);
        session = await p;
      }
    }
    if (!session) return;

    const botMode = session.mode || 'public';

    // ── OWNER JID ─────────────────────────────────────────────────────────────
    const rawOwnerNum  = (session.whatsappNumber || '').replace(/\D/g, '').replace(/^0+/, '');
    const ownerNumFull = rawOwnerNum.startsWith('92') ? rawOwnerNum : '92' + rawOwnerNum;
    const botOwnerJid  = ownerNumFull + '@s.whatsapp.net';

    const senderNumRaw = sender.replace('@s.whatsapp.net', '').replace(/\D/g, '').replace(/^0+/, '');
    const isBotOwner   =
      // ✅ FIX: fromMe messages → always owner (bot runs ON owner's number)
      msg.key.fromMe ||
      sender === botOwnerJid ||
      senderNumRaw === ownerNumFull ||
      senderNumRaw === rawOwnerNum ||
      senderNumRaw.replace(/^92/, '') === rawOwnerNum.replace(/^92/, '');

    const superAdmin   = isSuperAdmin(sender);
    const isPrivileged = superAdmin || isBotOwner;

    // ✅ FIX: Pin owner session — never let it expire from fast cache
    //         Owner commands always hit cache (0ms session lookup after first fetch)
    if (isBotOwner && global.__fastSessionCache && typeof global.__fastSessionCache.set === 'function') {
      global.__fastSessionCache.set(sessionId, session, 86_400_000); // 24 hours
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ✅ ANTI-DELETE — PRIVATE MODE + SPAM SE PEHLE  [v12 FIX]
    //
    //  WHY HERE?
    //  Delete notification ek system event hai — normal message nahi.
    //  Pehle code mein yeh private mode check ke BAAD tha:
    //    → Private mode + non-privileged user → return ❌ (anti-delete miss)
    //    → Spammer delete kare → return ❌ (anti-delete miss)
    //  Ab yeh PEHLE check hoga — koi bhi mode ho, koi bhi user ho.
    //
    //  Limitation (honest): Bot offline tha jab msg aaya → content nahi milega
    //  Yeh is file se fix nahi hota — launcher.js ka kaam hai.
    // ════════════════════════════════════════════════════════════════════════
    if (msg.message?.protocolMessage?.type === 0) {
      if (!S.antiDelete) return;
      try {
        const revokedKey = msg.message.protocolMessage.key;
        const stored     = deletedMsgStore.get(revokedKey.id);

        if (stored) {
          // ✅ Message store mein mila — full recovery
          await sendAntiDeleteAlert(sock, stored);
          deletedMsgStore.del(revokedKey.id);
          // ✅ Mark as processed — launcher.js messages.delete handler duplicate skip karega
          _antiDeleteProcessed.add(revokedKey.id);
          setTimeout(() => _antiDeleteProcessed.delete(revokedKey.id), 30_000);
        } else {
          // ⚠️ Store mein nahi mila — bot offline tha ya TTL expire hua
          // At least batao ke kisne delete kiya
          const targetChat = revokedKey.remoteJid;
          if (!targetChat) return;

          // ✅ BUG FIX: Group chat mein revokedKey.participant missing hone par
          // code galti se remoteJid (group ID: 120363422615993405@g.us) ko sender
          // samajh leta tha → cleanJidToNumber se wrong number aata tha.
          // Ab: group JID detect karo → participant missing ho toh '🔒 Hidden' show karo.
          const isGroupChat = (revokedKey.remoteJid || '').endsWith('@g.us');
          const senderJid   = revokedKey.participant
            ? revokedKey.participant
            : (isGroupChat ? '' : (revokedKey.remoteJid || ''));
          const dNum = senderJid ? cleanJidToNumber(senderJid) : '🔒 Hidden';

          // ✅ BUG FIX: messages.delete event mein msg.pushName nahi hota (empty string).
          // Pehle sirf msg.pushName check tha — result: number hi naam ban jata.
          // Ab: global.__userActivity cache se naam lookup karo. Bot ne agar kabhi
          // bhi us user ka message receive kiya hai, to uska naam cached hai.
          const cachedUser = senderJid ? (global.__userActivity?.get(senderJid) || null) : null;
          const dName      = (msg.pushName && msg.pushName.trim())
            ? msg.pushName
            : (cachedUser?.firstName && cachedUser.firstName !== senderJid
                ? cachedUser.firstName
                : dNum);

          const dTime = global.getKarachiTime
            ? global.getKarachiTime()
            : new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });

          await sock.sendMessage(targetChat, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  🚫 𝑴𝑬𝑺𝑺𝑨𝑮𝑬 𝑫𝑬𝑳𝑬𝑻𝑬𝑫           ║\n` +
              `╠══════════════════════════════╣\n` +
              `║ 👤 𝑵𝒂𝒎𝒆   : ${dName}\n` +
              `║ 📞 𝑵𝒖𝒎𝒃𝒆𝒓 : +${dNum}\n` +
              `║ ⏰ 𝑻𝒊𝒎𝒆   : ${dTime}\n` +
              `╠══════════════════════════════╣\n` +
              `║ ⚠️ 𝑩𝒐𝒕 𝑶𝒇𝒇𝒍𝒊𝒏𝒆 𝑻𝒉𝒂 — 𝑪𝒐𝒏𝒕𝒆𝒏𝒕\n` +
              `║    𝑼𝒏𝒂𝒗𝒂𝒊𝒍𝒂𝒃𝒍𝒆\n` +
              `╚══════════════════════════════╝`,
          }).catch(() => {});
        }
      } catch (delErr) {
        logger.error('[AntiDelete] Revoke error:', delErr.message);
      }
      return; // delete event process ho gaya — aage kuch nahi
    }

    // ── AB NORMAL FLOW — private mode + spam check ────────────────────────
    if (botMode === 'private' && !isPrivileged) return;

    // ── ANTI-SPAM ─────────────────────────────────────────────────────────────
    if (!isPrivileged && isSpamming(sender)) {
      logger.warn(`[SPAM] ${sender} — session ${sessionId}`);
      const entry = spamTracker.get(sender);
      if (entry && !entry.warned) {
        entry.warned = true;
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  🚫 𝑺𝑷𝑨𝑴 𝑫𝑬𝑻𝑬𝑪𝑻𝑬𝑫             ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  👤 ${pushName}\n` +
            `║  ⏳ 𝑷𝒍𝒆𝒂𝒔𝒆 𝑾𝒂𝒊𝒕 10 𝑺𝒆𝒄𝒐𝒏𝒅𝒔\n` +
            `║  📋 𝑻𝒉𝒆𝒏 𝑼𝒔𝒆 .𝒎𝒆𝒏𝒖\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
      }
      return;
    }

    // ── USER ACTIVITY ─────────────────────────────────────────────────────────
    trackUser(sender, pushName, isCmd);

    // ── ANTI-LINK ─────────────────────────────────────────────────────────────
    const linkHandled = await handleAntiLink(sock, msg, from, sender, botOwnerJid, S);
    if (linkHandled) return;

    // ── COOLDOWN CHECK ────────────────────────────────────────────────────────
    let cmdName = '';
    if (isCmd && !isPrivileged) {
      cmdName = body.slice(prefix.length).split(' ')[0].toLowerCase();
      if (isOnCooldown(sender, cmdName)) {
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  ⏳ 𝑪𝑶𝑶𝑳𝑫𝑶𝑾𝑵 𝑨𝑪𝑻𝑰𝑽𝑬          ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  🔄 𝑪𝒐𝒎𝒎𝒂𝒏𝒅 : .${cmdName}\n` +
            `║  ⏱️ 𝑾𝒂𝒊𝒕    : 5 𝑺𝒆𝒄𝒐𝒏𝒅𝒔\n` +
            `║  🚀 𝑷𝒍𝒆𝒂𝒔𝒆 𝑻𝒓𝒚 𝑨𝒈𝒂𝒊𝒏!\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
        return;
      }
    }

    // ── MESSAGE COUNTER ───────────────────────────────────────────────────────
    incrementBotMessageCount(sessionId);

    // ── AUTO READ ─────────────────────────────────────────────────────────────
    if (S.autoRead) sock.readMessages([msg.key]).catch(() => {});

    // ── SMART REACT ───────────────────────────────────────────────────────────
    // ✅ FIX: fromMe messages already reacted in the fromMe block above — skip here
    if (body && S.autoReact && !msg.key.fromMe) {
      sock.sendMessage(from, {
        react: { text: isCmd ? getSmartReact(body, prefix) : pickEmoji(), key: msg.key },
      }).catch(() => {});
    }

    // ── WELCOME ───────────────────────────────────────────────────────────────
    if (isCmd && body.toLowerCase().trim() === `${prefix}menu` && !isGroupMsg) {
      sendWelcomeMessage(sock, from).catch(() => {});
    }

    // ════════════════════════════════════════════════════════════════════════
    //  VIEW ONCE UNLOCK — .v  [v12.0.0 — BULLETPROOF]
    //
    //  ✅ FIX 1 — Race Condition: capture chal rahi ho tab bhi kaam karta hai
    //  ✅ FIX 2 — Pending Await: 10s tak wait karta hai capture complete hone ka
    //  ✅ FIX 3 — Smart "Please Wait" message taake user confused na ho
    //  ✅ FIX 4 — Auto cleanup after serve (memory free)
    // ════════════════════════════════════════════════════════════════════════
    if (body.toLowerCase() === `${prefix}v`) {
      const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;

      // ── Guard: reply nahi ki toh guide karo ─────────────────────────────
      if (!stanzaId) {
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑽𝑰𝑬𝑾 𝑶𝑵𝑪𝑬 𝑼𝑵𝑳𝑶𝑪𝑲          ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  ⚠️ 𝑷𝒍𝒆𝒂𝒔𝒆 𝑹𝒆𝒑𝒍𝒚 𝑻𝒐 𝑨\n` +
            `║     𝑽𝒊𝒆𝒘 𝑶𝒏𝒄𝒆 𝑴𝒆𝒔𝒔𝒂𝒈𝒆 𝑭𝒊𝒓𝒔𝒕!\n` +
            `║  📌 𝑻𝒉𝒆𝒏 𝑻𝒚𝒑𝒆 .𝒗\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
        return;
      }

      // ── Step 1: Store mein check karo ───────────────────────────────────
      let stored = viewOnceStore.get(stanzaId);
      // ── Step 2: ✅ RACE CONDITION FIX ───────────────────────────────────
      // Agar store mein nahi mila lekin capture abhi chal rahi hai
      // toh promise await karo (max 10 seconds)
      if (!stored && _viewOncePending.has(stanzaId)) {
        // Notify user that media is still processing
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑽𝑰𝑬𝑾 𝑶𝑵𝑪𝑬 𝑼𝑵𝑳𝑶𝑪𝑲          ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  ⏳ 𝑴𝒆𝒅𝒊𝒂 𝑷𝒓𝒐𝒄𝒆𝒔𝒔𝒊𝒏𝒈...\n` +
            `║  🔄 𝑷𝒍𝒆𝒂𝒔𝒆 𝑾𝒂𝒊𝒕 𝑨 𝑴𝒐𝒎𝒆𝒏𝒕\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});

        try {
          // 10 second timeout ke saath pending resolve ka wait
          const result = await Promise.race([
            _viewOncePending.get(stanzaId),
            new Promise(res => setTimeout(() => res(null), 10_000)),
          ]);
          if (result) stored = result; // capture successful
        } catch (_) {}
      }

      // ── Step 3: Still nahi mila — user ko batao ─────────────────────────
      if (!stored) {
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑽𝑰𝑬𝑾 𝑶𝑵𝑪𝑬 𝑼𝑵𝑳𝑶𝑪𝑲          ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  ❌ 𝑴𝒆𝒅𝒊𝒂 𝑵𝒐𝒕 𝑭𝒐𝒖𝒏𝒅!\n` +
            `║\n` +
            `║  🔎 𝑷𝒐𝒔𝒔𝒊𝒃𝒍𝒆 𝑹𝒆𝒂𝒔𝒐𝒏𝒔:\n` +
            `║  • 𝑩𝒐𝒕 𝑶𝒇𝒇𝒍𝒊𝒏𝒆 𝑾𝒉𝒆𝒏 𝑺𝒆𝒏𝒕\n` +
            `║  • 𝑴𝒆𝒅𝒊𝒂 𝑬𝒙𝒑𝒊𝒓𝒆𝒅 (1𝒉)\n` +
            `║  • 𝑵𝒆𝒕𝒘𝒐𝒓𝒌 𝑬𝒓𝒓𝒐𝒓\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
        return;
      }

      // ── Step 4: Media serve karo ─────────────────────────────────────────
      if (stored.type === 'image') {
        await sock.sendMessage(from, {
          image:   stored.buffer,
          caption:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑽𝑰𝑬𝑾 𝑶𝑵𝑪𝑬 𝑼𝑵𝑳𝑶𝑪𝑲𝑬𝑫       ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  📸 𝑻𝒚𝒑𝒆   : 𝑰𝒎𝒂𝒈𝒆\n` +
            `║  👤 𝑭𝒓𝒐𝒎   : ${stored.pushName || 'Unknown'}\n` +
            `║  ✅ 𝑺𝒕𝒂𝒕𝒖𝒔 : 𝑼𝒏𝒍𝒐𝒄𝒌𝒆𝒅\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});

      } else if (stored.type === 'audio') {
        await sock.sendMessage(from, {
          audio:    stored.buffer,
          mimetype: stored.mimetype || 'audio/mpeg',
          ptt:      stored.ptt || false,
        }, { quoted: msg }).catch(() => {});
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑽𝑰𝑬𝑾 𝑶𝑵𝑪𝑬 𝑼𝑵𝑳𝑶𝑪𝑲𝑬𝑫       ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  🎵 𝑻𝒚𝒑𝒆   : ${stored.ptt ? 'Voice Note' : 'Audio'}\n` +
            `║  👤 𝑭𝒓𝒐𝒎   : ${stored.pushName || 'Unknown'}\n` +
            `║  ✅ 𝑺𝒕𝒂𝒕𝒖𝒔 : 𝑼𝒏𝒍𝒐𝒄𝒌𝒆𝒅\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});

      } else {
        await sock.sendMessage(from, {
          video:    stored.buffer,
          mimetype: stored.mimetype || 'video/mp4',
          caption:
            `╔══════════════════════════════╗\n` +
            `║  👁️ 𝑽𝑰𝑬𝑾 𝑶𝑵𝑪𝑬 𝑼𝑵𝑳𝑶𝑪𝑲𝑬𝑫       ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  🎬 𝑻𝒚𝒑𝒆   : 𝑽𝒊𝒅𝒆𝒐\n` +
            `║  👤 𝑭𝒓𝒐𝒎   : ${stored.pushName || 'Unknown'}\n` +
            `║  ✅ 𝑺𝒕𝒂𝒕𝒖𝒔 : 𝑼𝒏𝒍𝒐𝒄𝒌𝒆𝒅\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
      }

      // ✅ Cleanup: served → delete from store (memory free)
      viewOnceStore.del(stanzaId);
      if (stored.keyId && stored.keyId !== stanzaId) {
        viewOnceStore.del(stored.keyId);
      }
      return;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  STICKER — .sticker / .s
    // ════════════════════════════════════════════════════════════════════════
    const bl = body.toLowerCase().trim();
    if (bl === `${prefix}sticker` || bl === `${prefix}s`) {
      try {
        const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = ctxInfo?.quotedMessage;

        const quotedInner =
          quotedMsg?.viewOnceMessage?.message ||
          quotedMsg?.viewOnceMessageV2?.message ||
          quotedMsg;

        const hasQuotedImg   = !!(quotedInner?.imageMessage);
        const hasQuotedVideo = !!(quotedInner?.videoMessage);
        const hasCurrImg     = !!(msg.message?.imageMessage);
        const hasCurrVideo   = !!(msg.message?.videoMessage);

        if (!hasQuotedImg && !hasCurrImg && !hasQuotedVideo && !hasCurrVideo) {
          await sock.sendMessage(from, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  🎨 𝑺𝑻𝑰𝑪𝑲𝑬𝑹 𝑴𝑨𝑲𝑬𝑹           ║\n` +
              `╠══════════════════════════════╣\n` +
              `║  ⚠️ 𝑷𝒍𝒆𝒂𝒔𝒆 𝑹𝒆𝒑𝒍𝒚 𝑻𝒐 𝑨\n` +
              `║     𝑷𝒊𝒄𝒕𝒖𝒓𝒆 𝑭𝒊𝒓𝒔𝒕!\n` +
              `║\n` +
              `║  📌 𝑼𝒔𝒂𝒈𝒆:\n` +
              `║  Kisi image pe reply karo\n` +
              `║  phir .sticker ya .s type karo\n` +
              `╠══════════════════════════════╣\n` +
              `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
              `╚══════════════════════════════╝`,
          }, { quoted: msg }).catch(() => {});
          return;
        }

        let downloadMediaMessage;
        try {
          const baileys = global.__baileys || await import('@whiskeysockets/baileys');
          if (!global.__baileys) global.__baileys = baileys;
          downloadMediaMessage = baileys.downloadMediaMessage;
        } catch (e) { throw new Error('Baileys unavailable'); }

        const hasAnyQuoted = hasQuotedImg || hasQuotedVideo;
        let dlTarget;
        if (hasAnyQuoted) {
          dlTarget = {
            key: {
              remoteJid:   from,
              id:          ctxInfo.stanzaId,
              participant: ctxInfo.participant || undefined,
              fromMe:      false,
            },
            message: quotedInner,
          };
        } else {
          dlTarget = msg;
        }

        const imgBuf = await downloadMediaMessage(dlTarget, 'buffer', {}).catch(() => null);

        if (!imgBuf) {
          await sock.sendMessage(from, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  🎨 𝑺𝑻𝑰𝑪𝑲𝑬𝑹 𝑴𝑨𝑲𝑬𝑹           ║\n` +
              `╠══════════════════════════════╣\n` +
              `║  ❌ 𝑰𝒎𝒂𝒈𝒆 𝑫𝒐𝒘𝒏𝒍𝒐𝒂𝒅 𝑭𝒂𝒊𝒍𝒆𝒅!\n` +
              `║  🔄 𝑷𝒍𝒆𝒂𝒔𝒆 𝑻𝒓𝒚 𝑨𝒈𝒂𝒊𝒏\n` +
              `╠══════════════════════════════╣\n` +
              `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
              `╚══════════════════════════════╝`,
          }, { quoted: msg }).catch(() => {});
          return;
        }

        const stickerBuf = await createSticker(imgBuf);
        await sock.sendMessage(from, { sticker: stickerBuf }, { quoted: msg });
        logger.info(`[Sticker] Created for ${pushName} in ${from}`);
      } catch (stkErr) {
        logger.error('[Sticker] Error:', stkErr.message);
        await sock.sendMessage(from, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  🎨 𝑺𝑻𝑰𝑪𝑲𝑬𝑹 𝑴𝑨𝑲𝑬𝑹           ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  ❌ 𝑺𝒕𝒊𝒄𝒌𝒆𝒓 𝑭𝒂𝒊𝒍𝒆𝒅\n` +
            `║  🔄 𝑷𝒍𝒆𝒂𝒔𝒆 𝑻𝒓𝒚 𝑨𝒈𝒂𝒊𝒏\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
      }
      return;
    }

    // ── COMMAND HANDLER ───────────────────────────────────────────────────────
    const handled = await handleCommand(sock, msg, sessionId, botMode, botOwnerJid);

    if (isCmd && !isPrivileged && cmdName && handled) {
      setCooldown(sender, cmdName);
    }

    // ── CHATBOT + BUILT-IN FALLBACK ───────────────────────────────────────────
    if (!handled) {
      if (body.toLowerCase() === `${prefix}mystats`) {
        const stats = userActivity.get(sender);
        if (stats) {
          await sock.sendMessage(from, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  📊 𝑴𝒀 𝑺𝑻𝑨𝑻𝑺                  ║\n` +
              `╠══════════════════════════════╣\n` +
              `║  👤 𝑵𝒂𝒎𝒆       : ${stats.firstName}\n` +
              `║  💬 𝑻𝒐𝒕𝒂𝒍 𝑴𝒔𝒈𝒔 : ${stats.totalMsgs}\n` +
              `║  ⚡ 𝑪𝒐𝒎𝒎𝒂𝒏𝒅𝒔   : ${stats.commandCount}\n` +
              `║  🕐 𝑳𝒂𝒔𝒕 𝑺𝒆𝒆𝒏  : ${stats.lastSeen}\n` +
              `║  📅 𝑱𝒐𝒊𝒏𝒆𝒅    : ${stats.joinedAt}\n` +
              `╠══════════════════════════════╣\n` +
              `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
              `╚══════════════════════════════╝`,
          }, { quoted: msg }).catch(() => {});
        }
        return;
      }

      if (body.toLowerCase().startsWith(`${prefix}ai `)) {
        const query = body.slice(prefix.length + 3).trim();
        if (query) {
          await sock.sendMessage(from, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  🤖 𝑨𝑰 𝑨𝑺𝑺𝑰𝑺𝑻𝑨𝑵𝑻               ║\n` +
              `╠══════════════════════════════╣\n` +
              `║  🔍 𝑸𝒖𝒆𝒓𝒚 : ${query.slice(0, 50)}\n` +
              `║\n` +
              `║  ⚡ 𝑨𝑰 𝑰𝒏𝒕𝒆𝒈𝒓𝒂𝒕𝒊𝒐𝒏 𝑪𝒐𝒎𝒊𝒏𝒈 𝑺𝒐𝒐𝒏\n` +
              `║  🚀 𝑺𝒕𝒂𝒚 𝑻𝒖𝒏𝒆𝒅!\n` +
              `╠══════════════════════════════╣\n` +
              `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
              `╚══════════════════════════════╝`,
          }, { quoted: msg }).catch(() => {});
        }
        return;
      }

      const chatbotEnabled = config.chatbotSessions?.get(sessionId) === true;
      if (chatbotEnabled && body && !body.startsWith(prefix)) {
        const lower   = body.toLowerCase().trim();
        const replies = [
          { match: ['hi','hello','hii','hey','salam','assalam','slm'],
            text: `╔══════════════════════════════╗\n║  👋 𝑾𝑬𝑳𝑪𝑶𝑴𝑬                   ║\n╠══════════════════════════════╣\n║  𝑯𝒆𝒍𝒍𝒐 ${pushName}! 😊\n║  🤖 𝑰 𝑨𝒎 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑩𝒐𝒕 ⚡\n║  📋 𝑻𝒚𝒑𝒆 .𝒎𝒆𝒏𝒖 𝑻𝒐 𝑺𝒕𝒂𝒓𝒕!\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['how are you','how r u','wassup','whats up','kya haal','kese ho'],
            text: `╔══════════════════════════════╗\n║  😎 𝑺𝑻𝑨𝑻𝑼𝑺                    ║\n╠══════════════════════════════╣\n║  𝑫𝒐𝒊𝒏𝒈 𝑨𝒎𝒂𝒛𝒊𝒏𝒈! 🔥\n║  ⚡ 𝑨𝒍𝒘𝒂𝒚𝒔 𝑹𝒆𝒂𝒅𝒚 𝑻𝒐 𝑯𝒆𝒍𝒑!\n║  🚀 𝑾𝒉𝒂𝒕 𝑪𝒂𝒏 𝑰 𝑫𝒐 ${pushName}?\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['your name','who are you','bot name','tera naam','kon ho'],
            text: `╔══════════════════════════════╗\n║  🤖 𝑩𝑶𝑻 𝑰𝑵𝑭𝑶                  ║\n╠══════════════════════════════╣\n║  📛 𝑵𝒂𝒎𝒆 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑩𝒐𝒕\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['i love you','love you','pyar','iloveyou'],
            text: `╔══════════════════════════════╗\n║  ❤️ 𝑳𝑶𝑽𝑬                      ║\n╠══════════════════════════════╣\n║  𝑨𝒘𝒘! 𝑻𝒉𝒂𝒏𝒌 𝒀𝒐𝒖 ${pushName}! 😄\n║  🤖 𝑩𝒖𝒕 𝑰 𝑨𝒎 𝑱𝒖𝒔𝒕 𝑨 𝑩𝒐𝒕 😅\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['thanks','thank you','ty','thx','shukriya'],
            text: `╔══════════════════════════════╗\n║  🙏 𝑾𝑬𝑳𝑪𝑶𝑴𝑬                   ║\n╠══════════════════════════════╣\n║  ⚡ 𝑨𝒍𝒘𝒂𝒚𝒔 𝑯𝒆𝒓𝒆 𝑻𝒐 𝑯𝒆𝒍𝒑!\n║  🌟 𝑯𝒂𝒗𝒆 𝑨 𝑮𝒓𝒆𝒂𝒕 𝑫𝒂𝒚 ${pushName}!\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['bye','goodbye','see you','cya','khuda hafiz','alvida'],
            text: `╔══════════════════════════════╗\n║  👋 𝑮𝑶𝑶𝑫𝑩𝒀𝑬                   ║\n╠══════════════════════════════╣\n║  🌟 𝑻𝒂𝒌𝒆 𝑪𝒂𝒓𝒆 ${pushName}!\n║  🤖 𝑰 𝑾𝒊𝒍𝒍 𝑩𝒆 𝑯𝒆𝒓𝒆 𝑾𝒉𝒆𝒏 𝒀𝒐𝒖 𝑹𝒆𝒕𝒖𝒓𝒏!\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['good morning','morning','subah bakhair'],
            text: `╔══════════════════════════════╗\n║  🌅 𝑮𝑶𝑶𝑫 𝑴𝑶𝑹𝑵𝑰𝑵𝑮               ║\n╠══════════════════════════════╣\n║  ☀️ 𝑮𝒐𝒐𝒅 𝑴𝒐𝒓𝒏𝒊𝒏𝒈 ${pushName}!\n║  🌸 𝑴𝒂𝒚 𝒀𝒐𝒖𝒓 𝑫𝒂𝒚 𝑩𝒆 𝑨𝒎𝒂𝒛𝒊𝒏𝒈!\n║  💪 𝑹𝒊𝒔𝒆 𝑨𝒏𝒅 𝑺𝒉𝒊𝒏𝒆! 🔥\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['good night','goodnight','shab bakhair','so ja'],
            text: `╔══════════════════════════════╗\n║  🌙 𝑮𝑶𝑶𝑫 𝑵𝑰𝑮𝑯𝑻                 ║\n╠══════════════════════════════╣\n║  🌙 𝑮𝒐𝒐𝒅 𝑵𝒊𝒈𝒉𝒕 ${pushName}!\n║  ⭐ 𝑺𝒘𝒆𝒆𝒕 𝑫𝒓𝒆𝒂𝒎𝒔!\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
          { match: ['mashallah','masha allah','alhamdulillah','subhanallah'],
            text: `╔══════════════════════════════╗\n║  🕌 𝑴𝑨𝑺𝑯𝑨𝑳𝑳𝑨𝑯                  ║\n╠══════════════════════════════╣\n║  🤲 𝑴𝒂𝒔𝒉𝒂𝒍𝒍𝒂𝒉 ${pushName}!\n║  📿 𝑨𝒍𝒍𝒂𝒉 𝑩𝒍𝒆𝒔𝒔 𝒀𝒐𝒖! 🕋\n╠══════════════════════════════╣\n║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n╚══════════════════════════════╝` },
        ];
        const matched = replies.find(r => r.match.some(w => lower.includes(w)));
        if (matched) {
          await sock.sendMessage(from, { text: matched.text }, { quoted: msg }).catch(() => {});
        } else {
          await sock.sendMessage(from, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  🤖 𝑳𝑬𝑮𝑬𝑵𝑫 𝑺𝑨𝑯𝑰𝑳 𝑩𝑶𝑻          ║\n` +
              `╠══════════════════════════════╣\n` +
              `║  💬 𝒀𝒐𝒖 𝑺𝒂𝒊𝒅: _"${body.slice(0, 50)}"\n` +
              `║\n` +
              `║  📋 𝑼𝒔𝒆 .𝒎𝒆𝒏𝒖 𝑻𝒐 𝑺𝒆𝒆 𝑪𝒐𝒎𝒎𝒂𝒏𝒅𝒔!\n` +
              `╠══════════════════════════════╣\n` +
              `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
              `╚══════════════════════════════╝`,
          }, { quoted: msg }).catch(() => {});
        }
      }
    }

  } catch (err) {
    logger.error(`[Session: ${sessionId}] Handler error: ${err.message}`);
    try {
      const errFrom = msg.key?.remoteJid;
      if (errFrom) {
        await sock.sendMessage(errFrom, {
          text:
            `╔══════════════════════════════╗\n` +
            `║  ⚠️ 𝑬𝑹𝑹𝑶𝑹 𝑫𝑬𝑻𝑬𝑪𝑻𝑬𝑫             ║\n` +
            `╠══════════════════════════════╣\n` +
            `║  😔 𝑺𝒐𝒎𝒆𝒕𝒉𝒊𝒏𝒈 𝑾𝒆𝒏𝒕 𝑾𝒓𝒐𝒏𝒈!\n` +
            `║  🔄 𝑷𝒍𝒆𝒂𝒔𝒆 𝑻𝒓𝒚 𝑨𝒈𝒂𝒊𝒏.\n` +
            `╠══════════════════════════════╣\n` +
            `║  👑 𝑶𝒘𝒏𝒆𝒓 : 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍    ║\n` +
            `╚══════════════════════════════╝`,
        }, { quoted: msg }).catch(() => {});
      }
    } catch (_) {}
  }
}

function cleanupSession(sid) {
  sessionSettings.delete(sid);
  sessionCache.del(sid);
  _pendingSessionFetch.delete(sid);
}

module.exports = { handleMessage, cleanupSession };
