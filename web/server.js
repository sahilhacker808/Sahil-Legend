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

app.get('/', (req, res) => res.json({
  name: 'SAHIL 804 BOT API', version: config.bot.version,
  status: 'running ✅', note: 'Frontend hosted separately on InfinityFree',
}));

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
