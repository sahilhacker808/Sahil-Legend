'use strict';
// ============================================================
//  SAHIL 804 BOT — API-ONLY SERVER (Railway)
//  ✅ No HTML files served — Frontend hosted separately
//  ✅ CORS enabled for InfinityFree / any external frontend
//  ✅ All /api/* routes work as before
//  ✅ WebSocket for QR code still works
// ============================================================

require('dotenv').config();

try { require('../speed boost'); } catch (_) {}

const express        = require('express');
const session        = require('express-session');
const helmet         = require('helmet');
const rateLimit      = require('express-rate-limit');
const http           = require('http');
const { WebSocketServer } = require('ws');
const QRCode         = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const config = require('../src/config/config');

const {
  logger, generateSessionId, validateSessionId, getAllActiveBots,
} = require('../src/utils/helpers');

const {
  hashPassword, comparePassword,
  isAuth, isAdmin, isPaid,
  isStrongPassword, isValidEmail, isValidWhatsApp,
} = require('../src/middleware/auth');

const {
  createUser, getUserByEmail, getUserById,
  getAllUsers, updateUser, deleteUser, approveUser, rejectUser,
  assignSubscription, revokeSubscription, getSubscription,
  getAllSubscriptions, isSubscriptionActive,
  createSession, getSession, getSessionsByUser, getAllSessions,
  updateSession, deleteSession, setSessionMode,
  getPaymentSettings, updatePaymentSettings,
  getActiveAnnouncement, createAnnouncement, deactivateAnnouncement,
} = require('../src/database/localDb');

const { startBot, stopBot }            = require('../src/bot/launcher');
const { cleanupSession }               = require('../src/handlers/messageHandler');
const NodeCache                        = require('node-cache');

// ✅ FIX: messageHandler mein global.__fastSessionCache use hota hai session ko cache karne ke liye
//         Agar yeh initialize nahi hota toh har message pe disk read hota tha → SLOW
//         Ab server start hote hi ek shared fast cache ban jata hai
global.__fastSessionCache = new NodeCache({ stdTTL: 600, checkperiod: 60, maxKeys: 5000 });

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// ─── Trust proxy (Railway) ─────────────────────────────────
app.set('trust proxy', 1);

// ─── CORS — Allow external frontend ───────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowed =
    !origin ||
    ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o)) ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1');

  if (isAllowed) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');

  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Security & Body Parsing ──────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Static Files — Serve web/public folder (same-origin, no CORS needed) ─
const path = require('path');
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));
// Fallback: serve index.html for any non-API route (SPA support)
app.get(/^(?!\/api).*$/, (req, res, next) => {
  const indexFile = path.join(__dirname, 'public', 'index.html');
  require('fs').access(indexFile, require('fs').constants.F_OK, (err) => {
    if (!err) res.sendFile(indexFile);
    else next();
  });
});

// ─── Sessions ─────────────────────────────────────────────
app.use(session({
  secret:            config.sessionSecret,
  resave:            false,
  saveUninitialized: false,
  name:              'sahil804.sid',
  cookie: {
    // ✅ FIX: sameSite:'none' sirf tab kaam karta hai jab secure:true ho
    //         Cross-origin frontend (InfinityFree ↔ Railway) ke liye dono required hain
    //         Dev mode mein bhi secure:true rakhna safe hai Railway HTTPS pe
    secure:   process.env.NODE_ENV !== 'development', // dev mein false, prod mein true
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'development' ? 'lax' : 'none',
  },
}));

// ─── Rate Limiters ────────────────────────────────────────
app.use('/api/',               rateLimit(config.rateLimit.general));
app.use('/api/bot/start-qr',   rateLimit(config.rateLimit.pairing));
app.use('/api/bot/start-pair', rateLimit(config.rateLimit.pairing));
app.use('/api/auth/login',     rateLimit(config.rateLimit.auth));
app.use('/api/auth/register',  rateLimit(config.rateLimit.auth));

app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) logger.debug(`${req.method} ${req.path}`);
  next();
});

// ─── WebSocket QR ─────────────────────────────────────────
const qrClients = new Map();

wss.on('connection', (ws, req) => {
  let sid;
  try { sid = new URL(req.url, 'http://x').searchParams.get('sessionId'); } catch (_) { sid = null; }
  if (sid) qrClients.set(sid, ws);
  ws.on('close', () => { if (sid) qrClients.delete(sid); });
  ws.on('error', () => { if (sid) qrClients.delete(sid); });
});

function wsSend(sessionId, data) {
  const ws = qrClients.get(sessionId);
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(data)); } catch (_) {} }
}

// ════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, whatsapp, password } = req.body;
    if (!name || !email || !whatsapp || !password)
      return res.status(400).json({ error: 'All fields required.' });
    if (name.trim().length < 2)
      return res.status(400).json({ error: 'Name must be at least 2 chars.' });
    if (!isValidEmail(email))
      return res.status(400).json({ error: 'Invalid email.' });
    if (!isValidWhatsApp(whatsapp))
      return res.status(400).json({ error: 'Invalid WhatsApp number.' });
    if (!isStrongPassword(password))
      return res.status(400).json({ error: 'Password min 8 chars + uppercase + special char.' });

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await getUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered.' });

    const hashed = await hashPassword(password);
    const uid    = uuidv4();
    await createUser(uid, {
      name: name.trim(), email: normalizedEmail,
      whatsapp: whatsapp.replace(/[^0-9]/g, ''),
      password: hashed, ip: req.ip || null,
    });
    logger.success(`New user: ${normalizedEmail}`);
    return res.json({ success: true, message: 'Account created! Waiting for admin approval.' });
  } catch (err) {
    logger.error('Register error:', err.message);
    return res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required.' });
    const user = await getUserByEmail(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'pending')  return res.status(403).json({ error: 'Account pending approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Account rejected.' });
    const valid = await comparePassword(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });
    await updateUser(user.id, { lastLogin: new Date().toISOString() });
    req.session.userId    = user.id;
    req.session.userEmail = user.email;
    return req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session save failed.' });
      logger.success(`Login: ${user.email}`);
      return res.json({ success: true, message: 'Login successful.' });
    });
  } catch (err) {
    logger.error('Login error:', err.message);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required.' });
    if (
      email.toLowerCase().trim() === config.admin.email.toLowerCase() &&
      password === config.admin.password
    ) {
      req.session.isAdmin = true;
      req.session.userId  = 'admin';
      return req.session.save(err => {
        if (err) return res.status(500).json({ error: 'Session error.' });
        logger.success('Admin logged in');
        return res.json({ success: true, message: 'Admin login successful.' });
      });
    }
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  } catch (err) {
    logger.error('Admin login error:', err.message);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {});
  res.clearCookie('sahil804.sid');
  return res.json({ success: true });
});

app.get('/api/auth/me', isAuth, async (req, res) => {
  try {
    if (req.session.isAdmin) return res.json({ isAdmin: true, email: config.admin.email });
    const user = await getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { password: _, ...safeUser } = user;
    return res.json(safeUser);
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// ════════════════════════════════════════════════════════════
//  USER ROUTES
// ════════════════════════════════════════════════════════════

app.get('/api/user/subscription', isAuth, async (req, res) => {
  try {
    const sub    = await getSubscription(req.session.userId);
    const active = sub ? await isSubscriptionActive(req.session.userId) : false;
    return res.json({ subscription: sub, active });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/user/status', async (req, res) => {
  if (!req.session?.userId) return res.json({ success: false, error: 'Not logged in.' });
  try {
    const user = await getUserById(req.session.userId);
    if (!user) return res.json({ success: false, error: 'User not found.' });
    const { password: _, ...safeUser } = user;
    return res.json({ success: true, user: safeUser });
  } catch (err) { return res.status(500).json({ success: false, error: 'Server error.' }); }
});

app.get('/api/user/bots', isAuth, async (req, res) => {
  try {
    const sessions = await getSessionsByUser(req.session.userId);
    const liveBots = getAllActiveBots();
    return res.json({
      bots: sessions.map(s => ({ ...s, isLive: liveBots.some(b => b.sessionId === s.sessionId) }))
    });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/announcement', async (req, res) => {
  try { return res.json({ announcement: await getActiveAnnouncement() }); }
  catch (_) { return res.json({ announcement: null }); }
});

app.get('/api/payment-info', async (req, res) => {
  try {
    const s = await getPaymentSettings();
    return res.json({ jazzcash: s.jazzcash, easypaisa: s.easypaisa, monthlyPrice: s.monthlyPrice, yearlyPrice: s.yearlyPrice, currency: s.currency, instructions: s.instructions });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// ════════════════════════════════════════════════════════════
//  BOT ROUTES
// ════════════════════════════════════════════════════════════

app.post('/api/bot/start-qr', isAuth, isPaid, async (req, res) => {
  try {
    const sessionId = generateSessionId();
    res.json({ success: true, sessionId });
    startBot(sessionId, req.session.userId,
      async (qr) => { try { const qrImage = await QRCode.toDataURL(qr); wsSend(sessionId, { type: 'qr', qr: qrImage, sessionId }); } catch (_) {} },
      null,
      (sid, number) => wsSend(sid, { type: 'connected', sessionId: sid, number }),
      (sid)         => wsSend(sid, { type: 'disconnected', sessionId: sid }),
    ).catch(err => logger.error('Bot QR error:', err.message));
  } catch (err) { return res.status(500).json({ error: 'Failed to start bot.' }); }
});

app.post('/api/bot/start-pair', isAuth, isPaid, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber || phoneNumber.replace(/[^0-9]/g, '').length < 10)
      return res.status(400).json({ error: 'Valid phone number required.' });
    const sessionId = generateSessionId();
    startBot(sessionId, req.session.userId, null,
      (code, err) => {
        if (code) wsSend(sessionId, { type: 'pairCode', code, sessionId });
        else       wsSend(sessionId, { type: 'pairError', error: err || 'Pair failed' });
      },
      (sid, number) => wsSend(sid, { type: 'connected', sessionId: sid, number }),
      (sid)         => wsSend(sid, { type: 'disconnected', sessionId: sid }),
      phoneNumber,
    ).catch(err => logger.error('Bot pair error:', err.message));
    return res.json({ success: true, sessionId });
  } catch (err) { return res.status(500).json({ error: 'Failed to start pairing.' }); }
});

app.post('/api/bot/stop', isAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required.' });
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    await stopBot(sessionId);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.delete('/api/bot/:sessionId', isAuth, async (req, res) => {
  try {
    const sess = await getSession(req.params.sessionId);
    if (!sess) return res.status(404).json({ error: 'Not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    await stopBot(req.params.sessionId);
    await deleteSession(req.params.sessionId);
    // ✅ FIX: sessionSettings + sessionCache cleanup — memory leak prevent
    cleanupSession(req.params.sessionId);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/bot/mode', isAuth, async (req, res) => {
  try {
    const { sessionId, mode } = req.body;
    if (!['public', 'private'].includes(mode)) return res.status(400).json({ error: 'Invalid mode.' });
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    await setSessionMode(sessionId, mode);
    return res.json({ success: true, mode });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/bot/restart', isAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    await stopBot(sessionId);
    setTimeout(() => startBot(sessionId, sess.userId, null, null,
      (sid, num) => logger.success(`Bot ${sid} restarted as +${num}`),
      (sid)      => logger.warn(`Bot ${sid} disconnected after restart`),
    ).catch(e => logger.error('Restart error:', e.message)), 2000);
    return res.json({ success: true, message: 'Bot restarting...' });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// ════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════════

app.get('/api/admin/stats', isAdmin, async (req, res) => {
  try {
    const [users, sessions, subs] = await Promise.all([getAllUsers(), getAllSessions(), getAllSubscriptions()]);
    const liveBots = getAllActiveBots();
    return res.json({
      totalUsers: users.length,
      approvedUsers: users.filter(u => u.status === 'approved').length,
      pendingApprovals: users.filter(u => u.status === 'pending').length,
      rejectedUsers: users.filter(u => u.status === 'rejected').length,
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === 'active').length,
      liveBots: liveBots.length,
      monthlySubscribers: subs.filter(s => s.plan === 'monthly').length,
      yearlySubscribers: subs.filter(s => s.plan === 'yearly').length,
    });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    return res.json({ users: users.map(({ password: _, ...u }) => u) });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/users/:uid/approve', isAdmin, async (req, res) => {
  try { await approveUser(req.params.uid); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/users/:uid/reject', isAdmin, async (req, res) => {
  try { await rejectUser(req.params.uid); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.delete('/api/admin/users/:uid', isAdmin, async (req, res) => {
  try { await deleteUser(req.params.uid); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/subscriptions/:uid', isAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['monthly', 'yearly'].includes(plan)) return res.status(400).json({ error: 'Invalid plan.' });
    await assignSubscription(req.params.uid, plan);
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.delete('/api/admin/subscriptions/:uid', isAdmin, async (req, res) => {
  try { await revokeSubscription(req.params.uid); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/admin/sessions', isAdmin, async (req, res) => {
  try {
    const sessions = await getAllSessions();
    const liveBots = getAllActiveBots();
    return res.json({ sessions: sessions.map(s => ({ ...s, isLive: liveBots.some(b => b.sessionId === s.sessionId) })) });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.delete('/api/admin/sessions/:sessionId', isAdmin, async (req, res) => {
  try { await stopBot(req.params.sessionId); await deleteSession(req.params.sessionId); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/admin/payment-settings', isAdmin, async (req, res) => {
  try { return res.json(await getPaymentSettings()); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/admin/payment-settings', isAdmin, async (req, res) => {
  try { await updatePaymentSettings(req.body); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/admin/live-bots', isAdmin, (req, res) => res.json({ bots: getAllActiveBots() }));

app.post('/api/admin/announcements', isAdmin, async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required.' });
    const id = await createAnnouncement(title, message, config.admin.email);
    return res.json({ success: true, id });
  } catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

app.delete('/api/admin/announcements/:id', isAdmin, async (req, res) => {
  try { await deactivateAnnouncement(req.params.id); return res.json({ success: true }); }
  catch (err) { return res.status(500).json({ error: 'Failed.' }); }
});

// ─── Health & Root ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: '✅ API Online', bot: config.bot.name, version: config.bot.version,
  uptime: Math.floor(process.uptime()), liveBots: getAllActiveBots().length,
  timestamp: new Date().toISOString(),
}));

// ─── Root → Bot Panel (HTML embedded — no file needed) ─────
const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAHIL 804 BOT — Panel</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2330;--accent:#f0a500;--accent2:#e8912c;--blue:#4fa3e8;--green:#3fcf6e;--red:#e85555;--text:#e6edf3;--muted:#8b949e;--border:#30363d;--shadow:0 8px 32px rgba(0,0,0,.5)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 20% 20%,rgba(240,165,0,.06) 0%,transparent 60%),radial-gradient(ellipse 60% 40% at 80% 80%,rgba(79,163,232,.06) 0%,transparent 60%);pointer-events:none;z-index:0}
.stars{position:fixed;inset:0;pointer-events:none;z-index:0}
.star{position:absolute;border-radius:50%;background:#fff;animation:twinkle var(--d,3s) ease-in-out infinite alternate}
@keyframes twinkle{0%{opacity:.1;transform:scale(.8)}100%{opacity:.7;transform:scale(1.2)}}
.wrap{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
.header{text-align:center;margin-bottom:28px;animation:fadeDown .7s ease}
.avatar{width:88px;height:88px;border-radius:50%;border:3px solid var(--accent);object-fit:cover;box-shadow:0 0 24px rgba(240,165,0,.4);animation:glow 2.5s ease-in-out infinite alternate}
@keyframes glow{0%{box-shadow:0 0 16px rgba(240,165,0,.3)}100%{box-shadow:0 0 36px rgba(240,165,0,.7)}}
.title{font-size:2rem;font-weight:800;margin-top:12px;background:linear-gradient(135deg,var(--accent),var(--blue),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:2px}
.subtitle{color:var(--muted);margin-top:4px;font-size:.95rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:28px;width:100%;max-width:440px;box-shadow:var(--shadow);animation:fadeUp .6s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:none}}
@keyframes fadeDown{from{opacity:0;transform:translateY(-20px)}to{opacity:1;transform:none}}
.tabs{display:flex;background:var(--card2);border-radius:12px;padding:4px;margin-bottom:24px;gap:4px}
.tab{flex:1;padding:10px;text-align:center;border-radius:9px;cursor:pointer;font-weight:600;font-size:.88rem;color:var(--muted);transition:all .25s;user-select:none;border:none;background:none}
.tab.active{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#111;box-shadow:0 4px 12px rgba(240,165,0,.3)}
.tab:hover:not(.active){color:var(--text);background:rgba(255,255,255,.05)}
.panel{display:none;animation:fadeUp .35s ease}
.panel.show{display:block}
label{display:block;font-size:.82rem;font-weight:600;color:var(--muted);margin-bottom:6px;margin-top:16px;text-transform:uppercase;letter-spacing:.5px}
label:first-child{margin-top:0}
.inp{width:100%;padding:13px 16px;background:var(--card2);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-size:.95rem;outline:none;transition:border .2s,box-shadow .2s}
.inp:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(240,165,0,.15)}
.inp::placeholder{color:var(--muted)}
.inp-wrap{position:relative}
.eye{position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--muted);font-size:1.1rem;user-select:none}
.eye:hover{color:var(--accent)}
.btn{width:100%;padding:14px;border:none;border-radius:11px;font-size:1rem;font-weight:700;cursor:pointer;margin-top:20px;transition:all .25s;position:relative;overflow:hidden}
.btn:active{transform:scale(.98)}
.btn-gold{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#111}
.btn-blue{background:linear-gradient(135deg,#4fa3e8,#3b82f6);color:#fff}
.btn-green{background:linear-gradient(135deg,var(--green),#27a85f);color:#fff}
.btn-red{background:linear-gradient(135deg,var(--red),#c0392b);color:#fff}
.btn-ghost{background:rgba(255,255,255,.06);color:var(--text);border:1.5px solid var(--border)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-sm{width:auto;padding:8px 18px;font-size:.85rem;margin-top:0}
.alert{padding:12px 16px;border-radius:10px;margin-top:16px;font-size:.9rem;font-weight:500;display:none;line-height:1.5}
.alert.show{display:block}
.alert-err{background:rgba(232,85,85,.15);border:1px solid rgba(232,85,85,.4);color:#ff8080}
.alert-ok{background:rgba(63,207,110,.12);border:1px solid rgba(63,207,110,.35);color:#5cdb8a}
.alert-info{background:rgba(79,163,232,.12);border:1px solid rgba(79,163,232,.35);color:#7ec8f5}
#dashboard{width:100%;max-width:660px;animation:fadeUp .5s ease}
.dash-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px}
.dash-title{font-size:1.4rem;font-weight:800}
.badge{padding:4px 12px;border-radius:20px;font-size:.78rem;font-weight:700}
.badge-gold{background:rgba(240,165,0,.2);color:var(--accent);border:1px solid rgba(240,165,0,.3)}
.badge-blue{background:rgba(79,163,232,.2);color:var(--blue);border:1px solid rgba(79,163,232,.3)}
.bots-grid{display:grid;gap:14px;margin-top:16px}
.bot-card{background:var(--card2);border:1.5px solid var(--border);border-radius:14px;padding:18px;transition:border .2s}
.bot-card:hover{border-color:var(--accent)}
.bot-top{display:flex;justify-content:space-between;align-items:flex-start}
.bot-num{font-weight:700;font-size:1rem}
.bot-status{padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:700}
.bot-status.on{background:rgba(63,207,110,.15);color:var(--green);border:1px solid rgba(63,207,110,.3)}
.bot-status.off{background:rgba(232,85,85,.1);color:var(--red);border:1px solid rgba(232,85,85,.25)}
.bot-id{font-size:.72rem;color:var(--muted);margin-top:4px;font-family:monospace;word-break:break-all}
.bot-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.pair-box{background:var(--card2);border:1.5px solid var(--border);border-radius:14px;padding:22px;margin-top:16px}
.pair-tabs{display:flex;gap:8px;margin-bottom:18px}
.pair-tab{flex:1;padding:10px;border-radius:9px;text-align:center;cursor:pointer;font-weight:700;font-size:.88rem;border:1.5px solid var(--border);background:none;color:var(--muted);transition:all .25s}
.pair-tab.active{border-color:var(--accent);color:var(--accent);background:rgba(240,165,0,.08)}
.pair-code-display{text-align:center;padding:28px;background:rgba(0,0,0,.3);border-radius:12px;margin-top:14px}
.pair-code{font-size:2.4rem;font-weight:900;letter-spacing:6px;font-family:monospace;background:linear-gradient(135deg,var(--accent),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
.pair-hint{color:var(--muted);font-size:.82rem;margin-top:8px}
.qr-wrap{text-align:center;padding:16px}
.qr-wrap img{width:200px;height:200px;border-radius:12px;border:3px solid var(--accent)}
.spin{display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,.2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.sec-title{font-size:1rem;font-weight:700;color:var(--accent);margin-bottom:14px}
#toast{position:fixed;bottom:24px;right:16px;z-index:999;display:flex;flex-direction:column;gap:8px;max-width:300px}
.toast-item{padding:12px 18px;border-radius:10px;font-size:.88rem;font-weight:600;animation:toastIn .3s ease;box-shadow:0 4px 20px rgba(0,0,0,.4)}
@keyframes toastIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}
.toast-ok{background:#1a3a28;border:1px solid var(--green);color:var(--green)}
.toast-err{background:#3a1a1a;border:1px solid var(--red);color:#ff8080}
.toast-info{background:#1a2a3a;border:1px solid var(--blue);color:var(--blue)}
.empty{text-align:center;padding:40px 20px;color:var(--muted)}
.empty-icon{font-size:3rem;margin-bottom:12px}
.logout-btn{padding:8px 18px;border-radius:8px;border:1.5px solid var(--border);background:none;color:var(--muted);cursor:pointer;font-size:.85rem;font-weight:600;transition:all .2s}
.logout-btn:hover{border-color:var(--red);color:var(--red)}
.card-wide{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:24px;width:100%;max-width:660px;box-shadow:var(--shadow);margin-top:16px}
@media(max-width:480px){.card{padding:20px 16px}.title{font-size:1.5rem}.pair-code{font-size:1.8rem;letter-spacing:3px}}
</style>
</head>
<body>
<div class="stars" id="stars"></div>
<div id="toast"></div>
<div class="wrap">

  <div class="header">
    <img class="avatar" src="https://i.ibb.co/Vc2LHyqv/IMG-20260408-WA0014.jpg" onerror="this.src='https://ui-avatars.com/api/?name=S804&background=f0a500&color=111&size=88'" alt="Bot"/>
    <div class="title">SAHIL 804 BOT</div>
    <div class="subtitle">WhatsApp Bot Platform — Control Panel</div>
  </div>

  <!-- LOGIN CARD -->
  <div class="card" id="loginCard">
    <div class="tabs">
      <button class="tab active" onclick="switchTab('user')" id="tabUser">👤 User</button>
      <button class="tab" onclick="switchTab('admin')" id="tabAdmin">👑 Admin</button>
      <button class="tab" onclick="switchTab('register')" id="tabReg">📝 Register</button>
    </div>

    <!-- User Login -->
    <div class="panel show" id="panelUser">
      <label>📧 Email</label>
      <input class="inp" id="uEmail" type="email" placeholder="your@email.com"/>
      <label>🔒 Password</label>
      <div class="inp-wrap">
        <input class="inp" id="uPwd" type="password" placeholder="Password"/>
        <span class="eye" onclick="togglePwd('uPwd',this)">👁</span>
      </div>
      <div class="alert alert-err" id="uAlert"></div>
      <button class="btn btn-blue" id="uBtn" onclick="doUserLogin()">🔐 Sign In</button>
    </div>

    <!-- Admin Login -->
    <div class="panel" id="panelAdmin">
      <label>📧 Admin Email</label>
      <input class="inp" id="aEmail" type="email" placeholder="admin@email.com"/>
      <label>🔒 Admin Password</label>
      <div class="inp-wrap">
        <input class="inp" id="aPwd" type="password" placeholder="Admin Password"/>
        <span class="eye" onclick="togglePwd('aPwd',this)">👁</span>
      </div>
      <div class="alert alert-err" id="aAlert"></div>
      <button class="btn btn-gold" id="aBtn" onclick="doAdminLogin()">👑 Admin Sign In</button>
    </div>

    <!-- Register -->
    <div class="panel" id="panelReg">
      <label>👤 Full Name</label>
      <input class="inp" id="rName" type="text" placeholder="Your Name"/>
      <label>📧 Email</label>
      <input class="inp" id="rEmail" type="email" placeholder="your@email.com"/>
      <label>📱 WhatsApp (country code ke sath)</label>
      <input class="inp" id="rWa" type="tel" placeholder="923001234567"/>
      <label>🔒 Password (8+ chars + Uppercase + Special)</label>
      <div class="inp-wrap">
        <input class="inp" id="rPwd" type="password" placeholder="StrongPass@123"/>
        <span class="eye" onclick="togglePwd('rPwd',this)">👁</span>
      </div>
      <div class="alert" id="rAlert"></div>
      <button class="btn btn-green" id="rBtn" onclick="doRegister()">📝 Create Account</button>
      <div style="color:var(--muted);font-size:.78rem;margin-top:12px;text-align:center">Admin approval ke baad login kar sako ge</div>
    </div>
  </div>

  <!-- DASHBOARD -->
  <div id="dashboard" style="display:none">
    <div class="dash-header">
      <div>
        <div class="dash-title">🤖 Bot Dashboard</div>
        <div style="color:var(--muted);font-size:.85rem;margin-top:4px" id="dashUser"></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <span class="badge badge-gold" id="dashBadge">User</span>
        <button class="logout-btn" onclick="doLogout()">🚪 Logout</button>
      </div>
    </div>

    <div class="alert alert-info" id="announcement" style="display:none;margin-bottom:16px"></div>

    <!-- Pairing -->
    <div class="card-wide">
      <div class="sec-title">⚡ WhatsApp Bot Connect Karo</div>
      <div class="pair-tabs">
        <button class="pair-tab active" onclick="setPairMode('code')" id="ptCode">📱 Pair Code</button>
        <button class="pair-tab" onclick="setPairMode('qr')" id="ptQR">📷 QR Code</button>
      </div>

      <div id="modeCode">
        <label>📞 WhatsApp Number (country code ke sath)</label>
        <div style="display:flex;gap:10px">
          <input class="inp" id="pairNum" type="tel" placeholder="923001234567" style="flex:1"/>
          <button class="btn btn-gold btn-sm" onclick="startPair()" id="pairBtn">Get Code</button>
        </div>
        <div style="color:var(--muted);font-size:.8rem;margin-top:8px">Example: 923001234567</div>
        <div id="pairWait" style="display:none;margin-top:16px;text-align:center;color:var(--muted)">
          <span class="spin"></span>Pair code aa raha hai...
        </div>
        <div id="pairResult" style="display:none">
          <div class="pair-code-display">
            <div class="pair-code" id="pairCodeText"></div>
            <div class="pair-hint">WhatsApp → Linked Devices → Link with phone number → Yeh code enter karo</div>
            <button onclick="copyCode()" style="margin-top:12px;padding:8px 20px;border-radius:8px;border:1px solid var(--accent);background:rgba(240,165,0,.1);color:var(--accent);cursor:pointer;font-weight:700">📋 Copy Code</button>
          </div>
        </div>
        <div class="alert alert-err" id="pairErr" style="display:none"></div>
      </div>

      <div id="modeQR" style="display:none">
        <div style="color:var(--muted);font-size:.88rem;margin-bottom:14px">WhatsApp → Linked Devices → Link a Device → QR scan karo</div>
        <button class="btn btn-blue" onclick="startQR()" id="qrBtn">📷 QR Code Generate Karo</button>
        <div id="qrWait" style="display:none;margin-top:16px;text-align:center;color:var(--muted)">
          <span class="spin"></span>QR generate ho raha hai...
        </div>
        <div class="qr-wrap" id="qrDisplay" style="display:none">
          <img id="qrImg" src="" alt="QR Code"/>
          <div class="pair-hint" style="margin-top:10px">Scan karo WhatsApp se</div>
        </div>
        <div class="alert alert-err" id="qrErr" style="display:none"></div>
      </div>
    </div>

    <!-- My Bots -->
    <div class="card-wide">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div class="sec-title" style="margin-bottom:0">🤖 Mere Bots</div>
        <button class="btn btn-ghost btn-sm" onclick="loadBots()">🔄 Refresh</button>
      </div>
      <div class="bots-grid" id="botsGrid">
        <div class="empty"><div class="empty-icon">🤖</div>Koi bot nahi — upar se connect karo</div>
      </div>
    </div>

    <!-- Admin Users -->
    <div id="adminSection" style="display:none">
      <div class="card-wide">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div class="sec-title" style="margin-bottom:0">👑 Admin — Users</div>
          <button class="btn btn-ghost btn-sm" onclick="loadAdminUsers()">🔄 Refresh</button>
        </div>
        <div id="adminUsers"><div class="empty"><span class="spin"></span> Loading...</div></div>
      </div>
    </div>
  </div>

</div>

<script>
// Stars
(function(){const c=document.getElementById('stars');for(let i=0;i<60;i++){const s=document.createElement('div');s.className='star';const z=Math.random()*2.5+.5;s.style.cssText='width:'+z+'px;height:'+z+'px;top:'+Math.random()*100+'%;left:'+Math.random()*100+'%;--d:'+( Math.random()*4+2)+'s;animation-delay:'+Math.random()*5+'s';c.appendChild(s);}})();

// API - same origin, no CORS!
async function api(p,o={}){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),20000);
  try{
    const r=await fetch(p,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(o.headers||{})},signal:c.signal,...o});
    clearTimeout(t);return r;
  }catch(e){clearTimeout(t);if(e.name==='AbortError')throw new Error('⏳ Server busy — retry karo');throw new Error('❌ Network error: '+e.message);}
}

// Toast
function toast(m,t='ok'){const b=document.getElementById('toast');const e=document.createElement('div');e.className='toast-item toast-'+t;e.textContent=m;b.appendChild(e);setTimeout(()=>{e.style.opacity='0';e.style.transition='opacity .4s';setTimeout(()=>e.remove(),400);},3500);}

// Alert
function showAlert(id,msg,t='err'){const e=document.getElementById(id);if(!e)return;e.className='alert alert-'+t+' show';e.textContent=msg;e.style.display='block';}
function hideAlert(id){const e=document.getElementById(id);if(e){e.style.display='none';e.classList.remove('show');}}

// Password
function togglePwd(id,eye){const i=document.getElementById(id);if(i.type==='password'){i.type='text';eye.textContent='🙈';}else{i.type='password';eye.textContent='👁';}}

// Tabs
function switchTab(t){
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('show'));
  const m={user:'User',admin:'Admin',register:'Reg'};
  document.getElementById('tab'+m[t])?.classList.add('active');
  document.getElementById('panel'+m[t])?.classList.add('show');
}

// Enter key
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  const id=document.activeElement?.id;
  if(['uEmail','uPwd'].includes(id))doUserLogin();
  else if(['aEmail','aPwd'].includes(id))doAdminLogin();
  else if(['rName','rEmail','rWa','rPwd'].includes(id))doRegister();
  else if(id==='pairNum')startPair();
});

// Auth
async function doUserLogin(){
  const email=document.getElementById('uEmail').value.trim();
  const pwd=document.getElementById('uPwd').value;
  if(!email||!pwd)return showAlert('uAlert','⚠️ Email aur password zaruri hain');
  hideAlert('uAlert');
  const btn=document.getElementById('uBtn');btn.disabled=true;btn.innerHTML='<span class="spin"></span>Signing in...';
  try{
    const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password:pwd})});
    const d=await r.json();
    if(r.ok&&d.success){toast('✅ Login successful!','ok');await initDash();}
    else showAlert('uAlert','❌ '+(d.error||'Login failed'));
  }catch(e){showAlert('uAlert',e.message);}
  finally{btn.disabled=false;btn.innerHTML='🔐 Sign In';}
}

async function doAdminLogin(){
  const email=document.getElementById('aEmail').value.trim();
  const pwd=document.getElementById('aPwd').value;
  if(!email||!pwd)return showAlert('aAlert','⚠️ Email aur password zaruri hain');
  hideAlert('aAlert');
  const btn=document.getElementById('aBtn');btn.disabled=true;btn.innerHTML='<span class="spin"></span>Signing in...';
  try{
    const r=await api('/api/auth/admin-login',{method:'POST',body:JSON.stringify({email,password:pwd})});
    const d=await r.json();
    if(r.ok&&d.success){toast('👑 Admin login! ','ok');await initDash();}
    else showAlert('aAlert','❌ '+(d.error||'Invalid credentials'));
  }catch(e){showAlert('aAlert',e.message);}
  finally{btn.disabled=false;btn.innerHTML='👑 Admin Sign In';}
}

async function doRegister(){
  const name=document.getElementById('rName').value.trim();
  const email=document.getElementById('rEmail').value.trim();
  const wa=document.getElementById('rWa').value.trim().replace(/[^0-9]/g,'');
  const pwd=document.getElementById('rPwd').value;
  if(!name||!email||!wa||!pwd)return showAlert('rAlert','⚠️ Sab fields zaruri hain','err');
  hideAlert('rAlert');
  const btn=document.getElementById('rBtn');btn.disabled=true;btn.innerHTML='<span class="spin"></span>Creating...';
  try{
    const r=await api('/api/auth/register',{method:'POST',body:JSON.stringify({name,email,whatsapp:wa,password:pwd})});
    const d=await r.json();
    if(r.ok&&d.success){showAlert('rAlert','✅ Account bana! Admin approval ka wait karo.','ok');toast('✅ Registered!','ok');}
    else showAlert('rAlert','❌ '+(d.error||'Failed'),'err');
  }catch(e){showAlert('rAlert',e.message,'err');}
  finally{btn.disabled=false;btn.innerHTML='📝 Create Account';}
}

async function doLogout(){
  try{await api('/api/auth/logout',{method:'POST'});}catch(_){}
  closeWS();
  document.getElementById('dashboard').style.display='none';
  document.getElementById('loginCard').style.display='block';
  toast('👋 Logout ho gaye','info');
}

// Dashboard
async function initDash(){
  try{
    const r=await api('/api/auth/me');if(!r.ok)return;
    const me=await r.json();
    document.getElementById('loginCard').style.display='none';
    document.getElementById('dashboard').style.display='block';
    if(me.isAdmin){
      document.getElementById('dashUser').textContent='👑 Admin: '+me.email;
      document.getElementById('dashBadge').textContent='👑 Admin';
      document.getElementById('adminSection').style.display='block';
      loadAdminUsers();
    }else{
      document.getElementById('dashUser').textContent='👤 '+(me.name||me.email);
      document.getElementById('dashBadge').textContent=me.plan||'Free';
      document.getElementById('dashBadge').className='badge badge-blue';
    }
    loadAnnouncement();loadBots();
  }catch(e){toast('Error: '+e.message,'err');}
}

async function loadAnnouncement(){
  try{const r=await api('/api/announcement');if(!r.ok)return;const d=await r.json();if(d.announcement?.message){const el=document.getElementById('announcement');el.textContent='📢 '+d.announcement.message;el.style.display='block';}}catch(_){}
}

async function loadBots(){
  const g=document.getElementById('botsGrid');g.innerHTML='<div class="empty"><span class="spin"></span> Loading...</div>';
  try{
    const r=await api('/api/user/bots');if(!r.ok){g.innerHTML='<div class="empty">Load nahi ho saka</div>';return;}
    const d=await r.json();const bots=d.bots||[];
    if(!bots.length){g.innerHTML='<div class="empty"><div class="empty-icon">🤖</div>Koi bot nahi — upar se connect karo!</div>';return;}
    g.innerHTML=bots.map(b=>'<div class="bot-card"><div class="bot-top"><div><div class="bot-num">📱 +'+(b.phoneNumber||b.number||'Unknown')+'</div><div class="bot-id">'+b.sessionId+'</div></div><span class="bot-status '+(b.status==='connected'?'on':'off')+'">'+(b.status==='connected'?'🟢 Online':'🔴 Offline')+'</span></div><div class="bot-actions"><button class="btn btn-ghost btn-sm" onclick="restartBot(\''+b.sessionId+'\')">🔄 Restart</button><button class="btn btn-red btn-sm" onclick="deleteBot(\''+b.sessionId+'\')">🗑 Delete</button></div></div>').join('');
  }catch(e){g.innerHTML='<div class="empty">Error: '+e.message+'</div>';}
}

async function restartBot(sid){if(!confirm('Bot restart karna hai?'))return;try{const r=await api('/api/bot/restart',{method:'POST',body:JSON.stringify({sessionId:sid})});if(r.ok){toast('🔄 Restarting...','info');setTimeout(loadBots,3000);}else{const d=await r.json();toast('❌ '+(d.error||'Failed'),'err');}}catch(e){toast(e.message,'err');}}
async function deleteBot(sid){if(!confirm('Bot delete karna hai?'))return;try{const r=await api('/api/bot/'+sid,{method:'DELETE'});if(r.ok){toast('🗑 Deleted','ok');loadBots();}else{const d=await r.json();toast('❌ '+(d.error||'Failed'),'err');}}catch(e){toast(e.message,'err');}}

// Pairing
let ws=null;
function setPairMode(m){
  document.getElementById('ptCode').classList.toggle('active',m==='code');
  document.getElementById('ptQR').classList.toggle('active',m==='qr');
  document.getElementById('modeCode').style.display=m==='code'?'block':'none';
  document.getElementById('modeQR').style.display=m==='qr'?'block':'none';
  closeWS();
}

function openWS(sid,cb){
  closeWS();
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host+'/ws?sessionId='+sid);
  ws.onmessage=e=>{try{cb(JSON.parse(e.data));}catch(_){}};
  ws.onerror=()=>toast('⚠️ WebSocket error','err');
}
function closeWS(){if(ws){try{ws.close();}catch(_){}ws=null;}}

async function startPair(){
  const num=document.getElementById('pairNum').value.trim().replace(/[^0-9]/g,'');
  if(num.length<10)return toast('⚠️ Valid number darj karo country code ke sath','err');
  const btn=document.getElementById('pairBtn');btn.disabled=true;btn.innerHTML='<span class="spin"></span>...';
  document.getElementById('pairWait').style.display='block';
  document.getElementById('pairResult').style.display='none';
  document.getElementById('pairErr').style.display='none';
  try{
    const r=await api('/api/bot/start-pair',{method:'POST',body:JSON.stringify({phoneNumber:num})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');
    openWS(d.sessionId,msg=>{
      if(msg.type==='pairCode'){
        document.getElementById('pairWait').style.display='none';
        document.getElementById('pairResult').style.display='block';
        document.getElementById('pairCodeText').textContent=msg.code;
        toast('✅ Code mila! WhatsApp mein enter karo','ok');
        setTimeout(loadBots,12000);
      }else if(msg.type==='pairError'){
        document.getElementById('pairWait').style.display='none';
        document.getElementById('pairErr').style.display='block';
        document.getElementById('pairErr').textContent='❌ '+(msg.error||'Pair failed');closeWS();
      }else if(msg.type==='connected'){
        toast('🟢 Bot connected! +'+msg.number,'ok');
        document.getElementById('pairResult').style.display='none';
        document.getElementById('pairWait').style.display='none';
        loadBots();closeWS();
      }
    });
  }catch(e){
    document.getElementById('pairWait').style.display='none';
    document.getElementById('pairErr').style.display='block';
    document.getElementById('pairErr').textContent='❌ '+e.message;
    toast(e.message,'err');
  }finally{btn.disabled=false;btn.innerHTML='Get Code';}
}

async function startQR(){
  const btn=document.getElementById('qrBtn');btn.disabled=true;btn.innerHTML='<span class="spin"></span>Generating...';
  document.getElementById('qrWait').style.display='block';
  document.getElementById('qrDisplay').style.display='none';
  document.getElementById('qrErr').style.display='none';
  try{
    const r=await api('/api/bot/start-qr',{method:'POST'});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Failed');
    openWS(d.sessionId,msg=>{
      if(msg.type==='qr'){document.getElementById('qrWait').style.display='none';document.getElementById('qrDisplay').style.display='block';document.getElementById('qrImg').src=msg.qr;toast('📷 QR ready — scan karo!','ok');}
      else if(msg.type==='connected'){toast('🟢 Bot connected! +'+msg.number,'ok');document.getElementById('qrDisplay').style.display='none';loadBots();closeWS();}
    });
  }catch(e){document.getElementById('qrWait').style.display='none';document.getElementById('qrErr').style.display='block';document.getElementById('qrErr').textContent='❌ '+e.message;toast(e.message,'err');}
  finally{btn.disabled=false;btn.innerHTML='📷 QR Code Generate Karo';}
}

function copyCode(){const c=document.getElementById('pairCodeText').textContent;if(!c)return;navigator.clipboard.writeText(c).then(()=>toast('📋 Code copy ho gaya!','ok')).catch(()=>{const t=document.createElement('textarea');t.value=c;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();toast('📋 Code copy ho gaya!','ok');});}

// Admin
async function loadAdminUsers(){
  const b=document.getElementById('adminUsers');b.innerHTML='<div class="empty"><span class="spin"></span> Loading...</div>';
  try{
    const r=await api('/api/admin/users');if(!r.ok){b.innerHTML='<div class="empty">Load nahi ho saka</div>';return;}
    const d=await r.json();const users=d.users||[];
    if(!users.length){b.innerHTML='<div class="empty">Koi user nahi</div>';return;}
    b.innerHTML=users.map(u=>'<div class="bot-card" style="margin-bottom:10px"><div class="bot-top"><div><div class="bot-num">'+(u.name||'Unknown')+' <span style="font-size:.8rem;color:var(--muted)">&lt;'+u.email+'&gt;</span></div><div class="bot-id">📱 '+(u.whatsapp||'-')+' | Plan: '+(u.plan||'free')+'</div></div><span class="bot-status '+(u.status==='approved'?'on':'off')+'">'+u.status+'</span></div>'+(u.status==='pending'?'<div class="bot-actions"><button class="btn btn-green btn-sm" onclick="approveUser(\''+u.id+'\')">✅ Approve</button><button class="btn btn-red btn-sm" onclick="rejectUser(\''+u.id+'\')">❌ Reject</button></div>':'<div class="bot-actions"><button class="btn btn-gold btn-sm" onclick="grantSub(\''+u.id+'\')">👑 Sub Do</button><button class="btn btn-red btn-sm" onclick="delUser(\''+u.id+'\')">🗑 Delete</button></div>')+'</div>').join('');
  }catch(e){b.innerHTML='<div class="empty">Error: '+e.message+'</div>';}
}
async function approveUser(uid){try{const r=await api('/api/admin/users/'+uid+'/approve',{method:'POST'});if(r.ok){toast('✅ Approved','ok');loadAdminUsers();}else{const d=await r.json();toast('❌ '+(d.error||'Failed'),'err');}}catch(e){toast(e.message,'err');}}
async function rejectUser(uid){try{const r=await api('/api/admin/users/'+uid+'/reject',{method:'POST'});if(r.ok){toast('Rejected','info');loadAdminUsers();}else{const d=await r.json();toast('❌ '+(d.error||'Failed'),'err');}}catch(e){toast(e.message,'err');}}
async function delUser(uid){if(!confirm('User delete karna hai?'))return;try{const r=await api('/api/admin/users/'+uid,{method:'DELETE'});if(r.ok){toast('🗑 Deleted','ok');loadAdminUsers();}else{const d=await r.json();toast('❌ '+(d.error||'Failed'),'err');}}catch(e){toast(e.message,'err');}}
async function grantSub(uid){const plan=prompt('Plan (monthly/yearly):','monthly');if(!plan)return;try{const r=await api('/api/admin/subscriptions/'+uid,{method:'POST',body:JSON.stringify({plan,months:1})});const d=await r.json();if(r.ok){toast('✅ Sub granted','ok');loadAdminUsers();}else toast('❌ '+(d.error||'Failed'),'err');}catch(e){toast(e.message,'err');}}

// Auto check session
window.addEventListener('load',async()=>{try{const r=await api('/api/auth/me');if(r.ok){const d=await r.json();if(d.isAdmin||d.id)await initDash();}}catch(_){}});
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PANEL_HTML);
});

// ─── 404 ──────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'API route not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Express error:', err.message);
  return res.status(500).json({ error: 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────
const PORT = config.port || 3000;
server.listen(PORT, () => {
  logger.success('╔══════════════════════════════════════════╗');
  logger.success('║   🤖  SAHIL 804 BOT  — FULL MODE         ║');
  logger.success(`║   🌐  Port     : ${PORT}                    ║`);
  logger.success('║   💾  Storage  : Local JSON Files         ║');
  logger.success('║   ✅  Panel    : /public/index.html       ║');
  logger.success('║   ✅  CORS     : Enabled for frontend     ║');
  logger.success('║   👑  Sahil Hacker 804                    ║');
  logger.success('╚══════════════════════════════════════════╝');
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
process.on('uncaughtException',  err => logger.error('Uncaught:', err.message));
process.on('unhandledRejection', r   => logger.error('Rejection:', r));

module.exports = app;
