'use strict';
// ============================================================
//  SAHIL 804 BOT — Local File Auth State (Replaces Firebase RTDB)
//  WhatsApp sessions stored in /src/auth_info_baileys/<sessionId>/
//
//  ✅ FIX 1: deleteKey function — pehle define nahi tha, crash hota tha
//  ✅ FIX 2: clearSession function — pehle define nahi tha, export fail hota
//  ✅ FIX 3: loadBaileys guard — agar import fail ho toh proper error
// ============================================================

const path = require('path');
const fs   = require('fs');

const SESSIONS_BASE = path.join(__dirname, '..', 'auth_info_baileys');

let _initAuthCreds, _BufferJSON;
async function loadBaileys() {
  if (!_initAuthCreds) {
    try {
      const b        = await import('@whiskeysockets/baileys');
      _initAuthCreds = b.initAuthCreds;
      _BufferJSON    = b.BufferJSON;
    } catch (e) {
      throw new Error('[AuthState] Baileys import failed: ' + e.message);
    }
  }
}

function sessionDir(sessionId) {
  return path.join(SESSIONS_BASE, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function keyFile(sessionId, key) {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(sessionDir(sessionId), `${safeKey}.json`);
}

function readKey(sessionId, key) {
  try {
    const f = keyFile(sessionId, key);
    if (!fs.existsSync(f)) return null;
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw, _BufferJSON?.reviver);
  } catch { return null; }
}

function writeKey(sessionId, key, value) {
  try {
    const f   = keyFile(sessionId, key);
    const tmp = f + '.tmp';
    fs.mkdirSync(sessionDir(sessionId), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, _BufferJSON?.replacer), 'utf8');
    fs.renameSync(tmp, f);
  } catch (err) {
    console.warn(`[AuthState] writeKey error ${key}:`, err.message);
  }
}

// ✅ FIX 1: deleteKey — pehle yeh function bilkul nahi tha
// keys.set() mein null value aane pe "deleteKey is not defined" crash deta tha
function deleteKey(sessionId, key) {
  try {
    const f = keyFile(sessionId, key);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (err) {
    console.warn(`[AuthState] deleteKey error ${key}:`, err.message);
  }
}

// ✅ FIX 2: clearSession — pehle yeh function define nahi tha
// Logout / loggedOut disconnect pe launcher.js isko call karta tha → "not defined" crash
function clearSession(sessionId) {
  try {
    const dir = sessionDir(sessionId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return Promise.resolve(true);
  } catch (err) {
    console.warn(`[AuthState] clearSession error ${sessionId}:`, err.message);
    return Promise.resolve(false);
  }
}

async function useLocalAuthState(sessionId) {
  await loadBaileys();

  fs.mkdirSync(sessionDir(sessionId), { recursive: true });

  // Load or init creds
  let creds = readKey(sessionId, 'creds');
  if (!creds) creds = _initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        const val = readKey(sessionId, `key_${type}_${id}`);
        if (val !== null) data[id] = val;
      }
      return data;
    },
    set: async (data) => {
      for (const [category, catData] of Object.entries(data)) {
        for (const [id, value] of Object.entries(catData)) {
          const key = `key_${category}_${id}`;
          if (value) writeKey(sessionId, key, value);
          else        deleteKey(sessionId, key); // ✅ Ab crash nahi hoga
        }
      }
    },
  };

  const saveCreds = async () => {
    writeKey(sessionId, 'creds', creds);
  };

  return {
    state:        { creds, keys },
    saveCreds,
    clearSession: () => clearSession(sessionId),
  };
}

module.exports = {
  useFirebaseAuthState: useLocalAuthState,  // drop-in alias — launcher.js unchanged
  useLocalAuthState,
  clearSession,
};
