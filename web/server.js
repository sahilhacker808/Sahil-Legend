'use strict';
// ============================================================
//  SAHIL 804 BOT — PAIR CODE ONLY SERVER
//  ✅ صرف Pair Code سسٹم
//  ✅ لاگ ان / ایڈمن پینل نہیں
//  ✅ یوزر نمبر درج کرے، Pair Code ملے، بوٹ کنیکٹ ہو
// ============================================================

require('dotenv').config();

try { require('./speed boost'); } catch (_) {}

const express             = require('express');
const http                = require('http');
const { WebSocketServer } = require('ws');
const rateLimit           = require('express-rate-limit');
const NodeCache           = require('node-cache');

const { logger, generateSessionId } = require('./src/utils/helpers');
const { startBot }                  = require('./src/bot/launcher');

// ─── Global fast cache ────────────────────────────────────
global.__fastSessionCache = new NodeCache({ stdTTL: 600, checkperiod: 60, maxKeys: 5000 });

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// ─── Trust proxy (Railway) ────────────────────────────────
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Body Parsing ─────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Rate Limiter ─────────────────────────────────────────
const pairLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 منٹ
  max: 5,               // 5 بار سے زیادہ نہیں
  message: { error: 'بہت زیادہ کوشش — ایک منٹ بعد دوبارہ کریں۔' },
});

// ─── WebSocket (Pair Code receive karne ke liye) ──────────
const pairClients = new Map();

wss.on('connection', (ws, req) => {
  let sid;
  try { sid = new URL(req.url, 'http://x').searchParams.get('sessionId'); } catch (_) { sid = null; }
  if (sid) pairClients.set(sid, ws);
  ws.on('close', () => { if (sid) pairClients.delete(sid); });
  ws.on('error', () => { if (sid) pairClients.delete(sid); });
});

function wsSend(sessionId, data) {
  const ws = pairClients.get(sessionId);
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════
//  API — Pair Code شروع کریں
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/pair
 * Body: { phoneNumber: "923001234567" }
 * Response: { success: true, sessionId: "SAHIL-XXXXXXXX" }
 * پھر WebSocket پر { type: "pairCode", code: "XXXX-XXXX" } آتا ہے
 */
app.post('/api/pair', pairLimiter, async (req, res) => {
  try {
    const raw = (req.body.phoneNumber || '').replace(/[^0-9]/g, '');
    if (raw.length < 10 || raw.length > 15) {
      return res.status(400).json({ error: 'درست نمبر درج کریں (مثال: 923001234567)' });
    }

    const sessionId = generateSessionId();

    // پہلے response بھیجو، پھر bot شروع کرو
    res.json({ success: true, sessionId });

    startBot(
      sessionId,
      'public-user',   // کوئی user ID نہیں — سادہ string
      null,            // QR callback نہیں چاہیے
      (code, err) => {
        if (code) {
          logger.success(`Pair code for ${raw}: ${code}`);
          wsSend(sessionId, { type: 'pairCode', code, sessionId });
        } else {
          logger.error(`Pair failed for ${raw}:`, err);
          wsSend(sessionId, { type: 'pairError', error: err || 'Pair نہیں ہو سکا' });
        }
      },
      (sid, number) => {
        logger.success(`Bot connected: +${number}`);
        wsSend(sid, { type: 'connected', sessionId: sid, number });
      },
      (sid) => {
        wsSend(sid, { type: 'disconnected', sessionId: sid });
      },
      raw, // phone number
    ).catch(err => {
      logger.error('Bot start error:', err.message);
      wsSend(sessionId, { type: 'pairError', error: 'Bot شروع نہیں ہو سکا' });
    });

  } catch (err) {
    logger.error('Pair API error:', err.message);
    return res.status(500).json({ error: 'Server error — دوبارہ کوشش کریں۔' });
  }
});

// ─── Health Check ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: '✅ Online',
  uptime: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
}));

// ═══════════════════════════════════════════════════════════
//  FRONT-END — Pair Code صفحہ (HTML)
// ═══════════════════════════════════════════════════════════
const PAGE_HTML = `<!DOCTYPE html>
<html lang="ur" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SAHIL 804 BOT — Pair Code</title>
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --accent: #f0a500;
    --green: #3fcf6e;
    --red: #e85555;
    --text: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 36px 28px;
    max-width: 440px;
    width: 100%;
    box-shadow: 0 8px 40px rgba(0,0,0,.5);
    text-align: center;
  }
  .logo { font-size: 2.8rem; margin-bottom: 8px; }
  h1 { font-size: 1.4rem; color: var(--accent); margin-bottom: 6px; }
  .sub { color: var(--muted); font-size: .9rem; margin-bottom: 28px; line-height: 1.5; }
  .input-wrap { position: relative; margin-bottom: 16px; text-align: right; }
  input {
    width: 100%;
    padding: 13px 16px;
    background: #0d1117;
    border: 1.5px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    font-size: 1rem;
    direction: ltr;
    transition: border-color .2s;
  }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: var(--muted); }
  .hint { font-size: .78rem; color: var(--muted); margin-bottom: 20px; text-align: right; }
  button {
    width: 100%;
    padding: 13px;
    background: var(--accent);
    color: #000;
    border: none;
    border-radius: 10px;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    transition: opacity .2s;
  }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .status {
    margin-top: 22px;
    padding: 14px;
    border-radius: 10px;
    font-size: .92rem;
    display: none;
  }
  .status.wait { background: #1c2330; color: var(--muted); border: 1px solid var(--border); }
  .status.code { background: #0f2a1a; color: var(--green); border: 1px solid var(--green); }
  .status.err  { background: #2a0f0f; color: var(--red);   border: 1px solid var(--red);   }
  .status.ok   { background: #0f2a1a; color: var(--green); border: 1px solid var(--green); }
  .code-box {
    font-size: 2rem;
    font-weight: 900;
    letter-spacing: 6px;
    margin: 10px 0;
    color: #fff;
    background: #0d1117;
    border-radius: 8px;
    padding: 12px;
    direction: ltr;
    user-select: all;
  }
  .copy-btn {
    margin-top: 10px;
    padding: 8px 18px;
    width: auto;
    font-size: .85rem;
    background: #30363d;
    color: var(--text);
    border-radius: 8px;
  }
  .steps {
    margin-top: 28px;
    text-align: right;
    background: #1c2330;
    border-radius: 10px;
    padding: 16px;
    font-size: .85rem;
    color: var(--muted);
    line-height: 2;
  }
  .steps b { color: var(--text); }
  .spin {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid var(--muted);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .7s linear infinite;
    margin-left: 6px;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🤖</div>
  <h1>SAHIL 804 BOT</h1>
  <p class="sub">اپنا واٹس ایپ نمبر درج کریں اور Pair Code حاصل کریں</p>

  <div class="input-wrap">
    <input
      id="numInput"
      type="tel"
      placeholder="923001234567"
      maxlength="15"
      inputmode="numeric"
      autocomplete="tel"
    />
  </div>
  <p class="hint">⚠️ نمبر میں کنٹری کوڈ شامل کریں — بغیر + کے (مثال: 923001234567)</p>

  <button id="pairBtn" onclick="startPair()">🔑 Pair Code حاصل کریں</button>

  <!-- Statuses -->
  <div id="stWait" class="status wait">
    <span class="spin"></span> Pair Code تیار ہو رہا ہے — چند سیکنڈ انتظار کریں...
  </div>
  <div id="stCode" class="status code">
    ✅ آپ کا Pair Code:
    <div class="code-box" id="codeText"></div>
    <button class="copy-btn" onclick="copyCode()">📋 Copy کریں</button>
    <div style="margin-top:10px;font-size:.8rem;color:var(--muted)">یہ کوڈ واٹس ایپ میں درج کریں — وقت محدود ہے!</div>
  </div>
  <div id="stErr" class="status err" id="stErr"></div>
  <div id="stOk"  class="status ok">🟢 بوٹ کنیکٹ ہو گیا! واٹس ایپ چیک کریں۔</div>

  <!-- Steps -->
  <div class="steps">
    <b>طریقہ کار:</b><br>
    1️⃣ اوپر اپنا نمبر لکھیں<br>
    2️⃣ <b>Pair Code حاصل کریں</b> بٹن دبائیں<br>
    3️⃣ واٹس ایپ کھولیں → <b>Linked Devices</b><br>
    4️⃣ <b>Link a Device</b> → <b>Link with phone number instead</b><br>
    5️⃣ یہاں دکھا کوڈ واٹس ایپ میں درج کریں ✅
  </div>
</div>

<script>
let ws = null;

function show(id) {
  ['stWait','stCode','stErr','stOk'].forEach(i => {
    document.getElementById(i).style.display = i === id ? 'block' : 'none';
  });
}

function closeWS() {
  if (ws) { try { ws.close(); } catch(_){} ws = null; }
}

function openWS(sid) {
  closeWS();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws?sessionId=' + sid);
  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'pairCode') {
        document.getElementById('codeText').textContent = msg.code;
        show('stCode');
      } else if (msg.type === 'pairError') {
        document.getElementById('stErr').textContent = '❌ ' + (msg.error || 'Pair نہیں ہو سکا');
        show('stErr');
        closeWS();
      } else if (msg.type === 'connected') {
        show('stOk');
        closeWS();
      }
    } catch(_) {}
  };
  ws.onerror = () => {
    document.getElementById('stErr').textContent = '❌ Connection error — دوبارہ کوشش کریں';
    show('stErr');
  };
}

async function startPair() {
  const raw = document.getElementById('numInput').value.trim().replace(/[^0-9]/g, '');
  if (raw.length < 10) {
    document.getElementById('stErr').textContent = '⚠️ درست نمبر درج کریں (مثال: 923001234567)';
    show('stErr');
    return;
  }

  const btn = document.getElementById('pairBtn');
  btn.disabled = true;
  btn.textContent = '⏳ درخواست بھیجی جا رہی ہے...';
  show('stWait');

  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: raw }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    openWS(data.sessionId);
  } catch (err) {
    document.getElementById('stErr').textContent = '❌ ' + err.message;
    show('stErr');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔑 Pair Code حاصل کریں';
  }
}

function copyCode() {
  const code = document.getElementById('codeText').textContent;
  if (!code) return;
  navigator.clipboard.writeText(code)
    .then(() => alert('✅ کوڈ کاپی ہو گیا!'))
    .catch(() => {
      const t = document.createElement('textarea');
      t.value = code;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
      alert('✅ کوڈ کاپی ہو گیا!');
    });
}

// Enter key support
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('numInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') startPair();
  });
});
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PAGE_HTML);
});

// ─── 404 ───────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

// ─── Error Handler ─────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Express error:', err.message);
  return res.status(500).json({ error: 'Internal server error.' });
});

// ─── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.success('╔══════════════════════════════════════════╗');
  logger.success('║   🤖  SAHIL 804 BOT  — PAIR CODE MODE   ║');
  logger.success(`║   🌐  Port : ${PORT}                         ║`);
  logger.success('║   ✅  Endpoint: POST /api/pair            ║');
  logger.success('║   ✅  WebSocket: /ws?sessionId=...        ║');
  logger.success('║   👑  Sahil Hacker 804                    ║');
  logger.success('╚══════════════════════════════════════════╝');
});

process.on('SIGTERM',             () => server.close(() => process.exit(0)));
process.on('SIGINT',              () => server.close(() => process.exit(0)));
process.on('uncaughtException',   err => logger.error('Uncaught:', err.message));
process.on('unhandledRejection',  r   => logger.error('Rejection:', r));

module.exports = app;
                      
