'use strict';
// ============================================================
//  SAHIL 804 BOT — Local JSON Database (Replaces Firebase)
//  v2.0.0 — PERFORMANCE FIXED
//
//  ✅ FIX 1: fs.readFileSync → fs.promises (non-blocking async!)
//  ✅ FIX 2: In-memory read cache (30s TTL) — same file 0ms re-read
//  ✅ FIX 3: Pending read dedup — 10 simultaneous requests = 1 disk read
//  ✅ FIX 4: Write debounce — burst writes batched per 50ms per file
//  ✅ FIX 5: Session writes auto-refresh fast cache in message handler
//
//  WHY IT MATTERS:
//  Old readFileSync BLOCKS Node.js event loop ~5-50ms per call.
//  If 10 users send commands simultaneously → each waits for previous.
//  Owner's command queues behind all regular user commands → SLOW.
//  Now all reads are non-blocking — everything runs in PARALLEL.
// ============================================================

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ─── Ensure data directories exist (sync only at startup) ─
const DIRS = ['users', 'sessions', 'subscriptions', 'settings', 'announcements'];
for (const d of DIRS) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}

// ════════════════════════════════════════════════════════
//  IN-MEMORY READ CACHE — 30s TTL
//  Same file won't hit disk again within 30 seconds.
// ════════════════════════════════════════════════════════
const _memCache     = new Map();
const MEM_CACHE_TTL = 30_000;

function memGet(fp) {
  const e = _memCache.get(fp);
  if (!e) return undefined;
  if (Date.now() > e.exp) { _memCache.delete(fp); return undefined; }
  return e.data;
}
function memSet(fp, data) {
  _memCache.set(fp, { data, exp: Date.now() + MEM_CACHE_TTL });
}
function memDel(fp) { _memCache.delete(fp); }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _memCache) if (now > v.exp) _memCache.delete(k);
}, 60_000);

// ════════════════════════════════════════════════════════
//  PENDING READ DEDUP
//  10 simultaneous requests for same file = 1 disk read.
// ════════════════════════════════════════════════════════
const _pending = new Map();

async function readJSON(fp) {
  const cached = memGet(fp);
  if (cached !== undefined) return cached;

  if (_pending.has(fp)) return await _pending.get(fp);

  const p = fsp.readFile(fp, 'utf8')
    .then(raw => {
      const parsed = JSON.parse(raw);
      memSet(fp, parsed);
      _pending.delete(fp);
      return parsed;
    })
    .catch(() => { _pending.delete(fp); return null; });

  _pending.set(fp, p);
  return await p;
}

// ════════════════════════════════════════════════════════
//  WRITE DEBOUNCE — 50ms batching per file
// ════════════════════════════════════════════════════════
const _writes = new Map();

async function writeJSON(fp, data) {
  memSet(fp, data); // reads see fresh data immediately

  if (_writes.has(fp)) {
    _writes.get(fp).data = data; // update pending data
    return true;
  }

  const entry = { data, timer: null };
  entry.timer = setTimeout(async () => {
    const d = _writes.get(fp);
    _writes.delete(fp);
    if (!d) return;
    try {
      const tmp = fp + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(d.data, null, 2), 'utf8');
      await fsp.rename(tmp, fp);
    } catch (e) { console.error('[DB] write error:', e.message); }
  }, 50);

  _writes.set(fp, entry);
  return true;
}

async function writeJSONNow(fp, data) {
  const pending = _writes.get(fp);
  if (pending) { clearTimeout(pending.timer); _writes.delete(fp); }
  memSet(fp, data);
  try {
    const tmp = fp + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, fp);
    return true;
  } catch (e) { console.error('[DB] writeNow error:', e.message); return false; }
}

async function deleteFile(fp) {
  memDel(fp);
  try { await fsp.unlink(fp); return true; } catch { return false; }
}

async function listDir(dir) {
  try {
    const files = await fsp.readdir(dir);
    return files.filter(f => f.endsWith('.json'));
  } catch { return []; }
}

// ─── PATH HELPERS ─────────────────────────────────────
const userPath    = uid => path.join(DATA_DIR, 'users',         `${uid}.json`);
const sessionPath = sid => path.join(DATA_DIR, 'sessions',      `${sid}.json`);
const subPath     = uid => path.join(DATA_DIR, 'subscriptions', `${uid}.json`);
const annPath     = id  => path.join(DATA_DIR, 'announcements', `${id}.json`);
const settPath    = ()  => path.join(DATA_DIR, 'settings',      'payment.json');

function now()       { return new Date().toISOString(); }
function fromDate(d) { return d instanceof Date ? d.toISOString() : d; }

// ════════════════════════════════════════════════════════
//  USERS
// ════════════════════════════════════════════════════════
async function createUser(uid, data) {
  const user = {
    id: uid, name: data.name || '',
    email: (data.email || '').toLowerCase().trim(),
    whatsapp: data.whatsapp || '', password: data.password || '',
    status: 'pending', plan: 'free', planExpiry: null,
    botsCreated: 0, botsAllowed: 0,
    createdAt: now(), lastLogin: null, ip: data.ip || null,
  };
  await writeJSONNow(userPath(uid), user);
}
async function getUserById(uid)    { return readJSON(userPath(uid)); }
async function updateUser(uid, data) {
  const user = (await readJSON(userPath(uid))) || {};
  await writeJSON(userPath(uid), { ...user, ...data, updatedAt: now() });
}
async function deleteUser(uid) {
  await Promise.all([deleteFile(userPath(uid)), deleteFile(subPath(uid))]);
}
async function approveUser(uid) { await updateUser(uid, { status: 'approved', approvedAt: now() }); }
async function rejectUser(uid)  { await updateUser(uid, { status: 'rejected', rejectedAt: now() }); }

async function getUserByEmail(email) {
  const files = await listDir(path.join(DATA_DIR, 'users'));
  const users = await Promise.all(files.map(f => readJSON(path.join(DATA_DIR, 'users', f))));
  return users.find(u => u && u.email === email.toLowerCase().trim()) || null;
}
async function getAllUsers() {
  const files = await listDir(path.join(DATA_DIR, 'users'));
  const users = await Promise.all(files.map(f => readJSON(path.join(DATA_DIR, 'users', f))));
  return users.filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ════════════════════════════════════════════════════════
//  SUBSCRIPTIONS
// ════════════════════════════════════════════════════════
async function assignSubscription(uid, plan) {
  const days = plan === 'yearly' ? 365 : 30;
  const botsAllowed = plan === 'yearly' ? 999 : 10;
  const expiry = new Date(); expiry.setDate(expiry.getDate() + days);
  const sub = {
    uid, plan, startDate: now(), expiry: fromDate(expiry),
    botsAllowed, botsUsed: 0, paymentStatus: 'confirmed',
    activatedBy: 'admin', activatedAt: now(),
  };
  await writeJSONNow(subPath(uid), sub);
  await updateUser(uid, { plan, planExpiry: fromDate(expiry), botsAllowed, status: 'approved' });
}
async function revokeSubscription(uid) {
  await deleteFile(subPath(uid));
  await updateUser(uid, { plan: 'free', planExpiry: null, botsAllowed: 0 });
}
async function getSubscription(uid)      { return readJSON(subPath(uid)); }
async function isSubscriptionActive(uid) {
  const sub = await getSubscription(uid);
  return sub ? new Date(sub.expiry) > new Date() : false;
}
async function getAllSubscriptions() {
  const files = await listDir(path.join(DATA_DIR, 'subscriptions'));
  const subs  = await Promise.all(files.map(f => readJSON(path.join(DATA_DIR, 'subscriptions', f))));
  return subs.filter(Boolean);
}

// ════════════════════════════════════════════════════════
//  BOT SESSIONS
// ════════════════════════════════════════════════════════
async function createSession(sessionId, userId, whatsappNumber) {
  const sess = {
    id: sessionId, sessionId, userId,
    whatsappNumber: whatsappNumber || '', status: 'active', mode: 'public',
    createdAt: now(), lastActive: now(), plan: 'free', messageCount: 0,
  };
  await writeJSONNow(sessionPath(sessionId), sess);
  const user = await readJSON(userPath(userId));
  if (user) await writeJSON(userPath(userId), { ...user, botsCreated: (user.botsCreated || 0) + 1 });
  // ✅ FIX: Safe check — global.__fastSessionCache sirf tab use karo jab exist kare
  //         Server.js mein initialize hota hai — agar nahi hua toh undefined check
  if (global.__fastSessionCache && typeof global.__fastSessionCache.set === 'function') {
    global.__fastSessionCache.set(sessionId, sess, 600_000);
  }
}

async function getSession(sessionId) {
  return readJSON(sessionPath(sessionId));
}

async function getSessionsByUser(userId) {
  const files    = await listDir(path.join(DATA_DIR, 'sessions'));
  const sessions = await Promise.all(files.map(f => readJSON(path.join(DATA_DIR, 'sessions', f))));
  return sessions
    .filter(s => s && s.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function getAllSessions() {
  const files    = await listDir(path.join(DATA_DIR, 'sessions'));
  const sessions = await Promise.all(files.map(f => readJSON(path.join(DATA_DIR, 'sessions', f))));
  return sessions.filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function updateSession(sessionId, data) {
  const sess    = (await readJSON(sessionPath(sessionId))) || {};
  const updated = { ...sess, ...data, lastActive: now() };
  await writeJSON(sessionPath(sessionId), updated);
  // ✅ FIX: Safe check before calling .set()
  if (global.__fastSessionCache && typeof global.__fastSessionCache.set === 'function') {
    global.__fastSessionCache.set(sessionId, updated, 600_000);
  }
}

async function deleteSession(sessionId) {
  const sess = await readJSON(sessionPath(sessionId));
  if (sess?.userId) {
    const user = await readJSON(userPath(sess.userId));
    if (user && user.botsCreated > 0)
      await writeJSON(userPath(sess.userId), { ...user, botsCreated: user.botsCreated - 1 });
  }
  await deleteFile(sessionPath(sessionId));
  // ✅ FIX: Safe check before calling .del()
  if (global.__fastSessionCache && typeof global.__fastSessionCache.del === 'function') {
    global.__fastSessionCache.del(sessionId);
  }
}

async function setSessionMode(sessionId, mode) {
  await updateSession(sessionId, { mode });
}

// ════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════
const DEFAULT_PAYMENT_SETTINGS = {
  jazzcash: '03496049312', easypaisa: '03496049312',
  monthlyPrice: '500', yearlyPrice: '4000', currency: 'PKR',
  instructions: 'Send payment screenshot to WhatsApp after paying.',
};
async function getPaymentSettings() {
  return (await readJSON(settPath())) || DEFAULT_PAYMENT_SETTINGS;
}
async function updatePaymentSettings(data) {
  const current = await getPaymentSettings();
  await writeJSON(settPath(), { ...current, ...data });
}

// ════════════════════════════════════════════════════════
//  ANNOUNCEMENTS
// ════════════════════════════════════════════════════════
async function createAnnouncement(title, message, adminEmail) {
  const id  = `ann_${Date.now()}`;
  const ann = { id, title, message, createdBy: adminEmail, createdAt: now(), active: true };
  await writeJSONNow(annPath(id), ann);
  return id;
}
async function getActiveAnnouncement() {
  const files = await listDir(path.join(DATA_DIR, 'announcements'));
  const anns  = (await Promise.all(files.map(f => readJSON(path.join(DATA_DIR, 'announcements', f)))))
    .filter(a => a && a.active)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return anns[0] || null;
}
async function deactivateAnnouncement(id) {
  const ann = await readJSON(annPath(id));
  if (ann) await writeJSON(annPath(id), { ...ann, active: false });
}

// ════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════
module.exports = {
  initOk: true, db: null, rtdb: null,
  createUser, getUserById, getUserByEmail, getAllUsers, updateUser, deleteUser, approveUser, rejectUser,
  assignSubscription, revokeSubscription, getSubscription, getAllSubscriptions, isSubscriptionActive,
  createSession, getSession, getSessionsByUser, getAllSessions, updateSession, deleteSession, setSessionMode,
  getPaymentSettings, updatePaymentSettings,
  createAnnouncement, getActiveAnnouncement, deactivateAnnouncement,
  Timestamp: { now: () => now(), fromDate: d => fromDate(d) },
  FieldValue: { increment: n => n },
  admin: null,
};
