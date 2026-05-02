'use strict';
// ============================================================
//  launcher.js — No Firebase Edition
//  Auth state stored locally in /src/auth_info_baileys/
// ============================================================

const path = require('path');
const fs   = require('fs');

const config  = require('../config/config');
const { logger, registerBot, removeBot, generateSessionId } = require('../utils/helpers');
const { handleMessage }                                      = require('../handlers/messageHandler');
const { createSession, getSession, updateSession } = require('../database/localDb');
const { useFirebaseAuthState, clearSession: clearLocalSession } = require('../utils/firebaseAuthState');

process.on('uncaughtException',  err => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', err => console.error('REJECTION:', err));

const SESSIONS_DIR      = path.join(__dirname, '..', 'auth_info_baileys');
const reconnectAttempts = new Map();
const reconnectTimers   = new Map();
const MAX_RECONNECT     = 10;
const activeSockets     = new Map();

const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info:  () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => silentLogger,
};

let _baileys = null;
async function getBaileys() {
  if (_baileys) return _baileys;
  _baileys = await import('@whiskeysockets/baileys');
  global.__baileys = _baileys;
  return _baileys;
}

async function startBot(sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, phoneNumber = null) {
  try {
    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
    } = await getBaileys();

    if (!sessionId) sessionId = generateSessionId();

    if (activeSockets.has(sessionId)) {
      try {
        const s = activeSockets.get(sessionId);
        if (typeof s.ws?.close === 'function') s.ws.close();
        else if (typeof s.end === 'function')  s.end(undefined);
      } catch (_) {}
      activeSockets.delete(sessionId);
      await new Promise(r => setTimeout(r, 2000));
    }

    if (reconnectTimers.has(sessionId)) {
      clearTimeout(reconnectTimers.get(sessionId));
      reconnectTimers.delete(sessionId);
    }

    // ── Local auth state (no Firebase) ──
    const authDir = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useFirebaseAuthState(sessionId);
    logger.info(`Using local auth state for session: ${sessionId}`);

    let version;
    try {
      const r = await fetchLatestBaileysVersion();
      version = r.version;
    } catch (_) {
      version = [2, 3000, 1015526];
    }

    let pairCodeRequested = false;

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      printQRInTerminal:              false,
      logger:                         silentLogger,
      browser:                        Browsers.ubuntu('Chrome'),
      connectTimeoutMs:               30_000,
      defaultQueryTimeoutMs:          30_000,
      keepAliveIntervalMs:            25_000,
      markOnlineOnConnect:            true,
      generateHighQualityLinkPreview: false,
      syncFullHistory:                false,
      fireInitQueries:                false,
    });

    activeSockets.set(sessionId, sock);
    sock.ev.on('creds.update', saveCreds);

    // ── Connection update ──────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && onQR) onQR(qr);

      if (connection === 'connecting' && phoneNumber && !state.creds.registered && !pairCodeRequested) {
        pairCodeRequested = true;
        setTimeout(async () => {
          if (!activeSockets.has(sessionId)) return;
          try {
            const cleanNum = phoneNumber.replace(/[^0-9]/g, '').replace(/^0+/, '');
            const code     = await sock.requestPairingCode(cleanNum);
            if (onPairCode) onPairCode(code);
          } catch (err) {
            if (onPairCode) onPairCode(null, err.message);
          }
        }, 3000);
      }

      if (connection === 'close') {
        const statusCode      = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(`Bot ${sessionId} disconnected. Code: ${statusCode}`);
        activeSockets.delete(sessionId);
        removeBot(sessionId);
        await updateSession(sessionId, { status: 'inactive' }).catch(() => {});

        if (shouldReconnect) {
          const attempts = (reconnectAttempts.get(sessionId) || 0) + 1;
          reconnectAttempts.set(sessionId, attempts);

          if (attempts > MAX_RECONNECT) {
            logger.error(`Max reconnect reached for ${sessionId}`);
            reconnectAttempts.delete(sessionId);
            reconnectTimers.delete(sessionId);
            // ✅ FIX: Session status update missing tha — DB mein still 'active' tha
            await updateSession(sessionId, { status: 'inactive' }).catch(() => {});
            if (onDisconnected) onDisconnected(sessionId);
            return;
          }

          const delay = Math.min(5000 * attempts, 60_000);
          logger.info(`Reconnecting ${sessionId} in ${delay}ms (attempt ${attempts})`);
          const timer = setTimeout(() => {
            reconnectTimers.delete(sessionId);
            startBot(sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, phoneNumber);
          }, delay);
          reconnectTimers.set(sessionId, timer);
        } else {
          reconnectAttempts.delete(sessionId);
          reconnectTimers.delete(sessionId);
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
          clearLocalSession(sessionId).catch(() => {});
          if (onDisconnected) onDisconnected(sessionId);
        }
      }

      if (connection === 'open') {
        reconnectAttempts.delete(sessionId);
        const rawId     = sock.user?.id || '';
        const botNumber = rawId.replace(/:[0-9]+@/, '@').replace('@s.whatsapp.net', '');
        logger.info(`Bot ${sessionId} connected as +${botNumber}`);
        registerBot(sessionId, sock, 'public');

        const existingSession = await getSession(sessionId);
        if (!existingSession) {
          await createSession(sessionId, userId, botNumber);
        } else {
          await updateSession(sessionId, { status: 'active', whatsappNumber: botNumber });
        }

        const welcomeMsg =
          `╭━━━〔 🚀 𝑺𝑨𝑯𝑰𝑳 𝟖𝟎𝟒 𝑩𝑶𝑻 〕━━━╮\n` +
          `┃\n` +
          `┃ 🌐 𝑶𝒇𝒇𝒊𝒄𝒊𝒂𝒍 𝑪𝒉𝒂𝒏𝒏𝒆𝒍\n` +
          `┃ 🔗 https://whatsapp.com/channel/0029Vb7ufE7It5rzLqedDc3l\n` +
          `┃\n` +
          `┃ 👤 𝑶𝒘𝒏𝒆𝒓 𝑪𝒐𝒏𝒕𝒂𝒄𝒕\n` +
          `┃ 📞 +923711158307\n` +
          `┃\n` +
          `┃ ⚙️ 𝑩𝒐𝒕 𝑰𝒏𝒔𝒕𝒂𝒏𝒕𝒍𝒚 𝑨𝒄𝒕𝒊𝒗𝒆 ✅\n` +
          `┃\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━╯`;

        const jid = rawId.replace(/:[0-9]+@/, '@') || `${botNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: welcomeMsg }).catch(() => {});
        if (onConnected) onConnected(sessionId, botNumber);
      }
    });

    // ── Messages ───────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      await Promise.allSettled(
        messages
          .filter(msg => msg.message)
          .map(msg => handleMessage(sock, msg, sessionId).catch(err => logger.error(err.message)))
      );
    });

    // ── Anti-Delete (messages.delete) ─────────────────────
    sock.ev.on('messages.delete', async (item) => {
      try {
        const keys = item?.keys || [];
        if (!keys.length) return;
        const getSettings = global.__getSettings;
        if (!getSettings) return;
        const S = getSettings(sessionId);
        if (!S?.antiDelete) return;

        await new Promise(r => setTimeout(r, 400));

        for (const key of keys) {
          const keyId = key.id;
          const alreadyProcessed = global.__antiDeleteProcessed?.has(keyId);
          if (alreadyProcessed) {
            global.__antiDeleteProcessed.delete(keyId);
            continue;
          }
          const fakeMsg = {
            key: {
              remoteJid:   key.remoteJid,
              fromMe:      false,
              id:          `del_${keyId}_${sessionId}`,
              participant: key.participant || undefined,
            },
            message: { protocolMessage: { type: 0, key } },
            pushName:         '',
            messageTimestamp: Math.floor(Date.now() / 1000),
          };
          await handleMessage(sock, fakeMsg, sessionId).catch(() => {});
        }
      } catch (err) {
        logger.error('[messages.delete] error:', err.message);
      }
    });

    return sock;
  } catch (err) {
    console.error('BOT START ERROR:', err);
    throw err;
  }
}

async function stopBot(sessionId) {
  try {
    if (reconnectTimers.has(sessionId)) {
      clearTimeout(reconnectTimers.get(sessionId));
      reconnectTimers.delete(sessionId);
    }
    reconnectAttempts.delete(sessionId);
    if (activeSockets.has(sessionId)) {
      try { activeSockets.get(sessionId).end(undefined); } catch (_) {}
      activeSockets.delete(sessionId);
    }
    removeBot(sessionId);
    await updateSession(sessionId, { status: 'inactive' }).catch(() => {});
    logger.info(`Bot ${sessionId} stopped`);
  } catch (e) {
    console.error(e);
  }
}

module.exports = { startBot, stopBot };
