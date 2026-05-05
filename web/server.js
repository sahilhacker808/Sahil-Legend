'use strict';
// ============================================================
//  SAHIL 804 BOT — SIMPLE PAIR CODE SERVER
//  ✅ کوئی Login نہیں، کوئی Admin نہیں
//  ✅ صرف: نمبر ڈالو → Pair Code لو → Bot Connect ہو جائے
// ============================================================

require('dotenv').config();

try { require('../speed boost'); } catch (_) {}

const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const QRCode    = require('qrcode');
const NodeCache = require('node-cache');

const { logger, generateSessionId } = require('../src/utils/helpers');
const { startBot }                  = require('../src/bot/launcher');

// Global cache (messageHandler ke liye zaroori)
global.__fastSessionCache = new NodeCache({ stdTTL: 600, checkperiod: 60, maxKeys: 5000 });

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── WebSocket ────────────────────────────────────────────
const wsClients = new Map();

wss.on('connection', (ws, req) => {
  let sid;
  try { sid = new URL(req.url, 'http://x').searchParams.get('sessionId'); } catch (_) { sid = null; }
  if (sid) wsClients.set(sid, ws);
  ws.on('close', () => { if (sid) wsClients.delete(sid); });
  ws.on('error', () => { if (sid) wsClients.delete(sid); });
});

function wsSend(sessionId, data) {
  const ws = wsClients.get(sessionId);
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}

// ─── API: Pair Code ───────────────────────────────────────
app.post('/api/pair', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const clean = (phoneNumber || '').replace(/[^0-9]/g, '');
    if (clean.length < 10)
      return res.status(400).json({ error: 'Valid phone number required (with country code).' });

    const sessionId = generateSessionId();
    res.json({ success: true, sessionId });

    startBot(
      sessionId,
      'guest',
      async (qr) => {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          wsSend(sessionId, { type: 'qr', qr: dataUrl, sessionId });
        } catch (_) {}
      },
      (code, err) => {
        if (code) wsSend(sessionId, { type: 'pairCode', code, sessionId });
        else      wsSend(sessionId, { type: 'pairError', error: err || 'Pair code failed.' });
      },
      (sid, number) => wsSend(sid, { type: 'connected', sessionId: sid, number }),
      (sid)         => wsSend(sid, { type: 'disconnected', sessionId: sid }),
      clean,
    ).catch(err => {
      logger.error('Bot pair error:', err.message);
      wsSend(sessionId, { type: 'pairError', error: err.message });
    });

  } catch (err) {
    logger.error('Pair route error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── Health Check ─────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({ status: 'ok', message: 'Sahil 804 Bot Running ✅' });
});

// ─── Main HTML ────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ur" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🤖 Sahil 804 Bot — Pair Code</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d0d0d;--card:#161616;--border:#2a2a2a;
    --accent:#f0a500;--blue:#3b82f6;--muted:#888;
    --text:#f0f0f0;--green:#22c55e;--red:#ef4444;
  }
  body{
    background:var(--bg);color:var(--text);
    font-family:'Segoe UI',Tahoma,sans-serif;
    min-height:100vh;display:flex;align-items:center;
    justify-content:center;padding:20px;
  }
  .card{
    background:var(--card);border:1.5px solid var(--border);
    border-radius:20px;padding:36px 28px;width:100%;max-width:430px;
    box-shadow:0 8px 40px rgba(0,0,0,.6);
  }
  .logo{text-align:center;margin-bottom:28px}
  .logo .icon{font-size:3rem;display:block;margin-bottom:8px}
  .logo h1{font-size:1.6rem;font-weight:800;color:var(--accent)}
  .logo p{color:var(--muted);font-size:.85rem;margin-top:4px}
  .label{display:block;color:var(--muted);font-size:.82rem;margin-bottom:6px;font-weight:600}
  .inp{
    width:100%;padding:13px 16px;background:#0d0d0d;
    border:1.5px solid var(--border);border-radius:10px;
    color:var(--text);font-size:1rem;outline:none;
    transition:border-color .2s;direction:ltr;
  }
  .inp:focus{border-color:var(--accent)}
  .inp::placeholder{color:#555}
  .btn{
    width:100%;padding:14px;margin-top:14px;
    background:linear-gradient(135deg,var(--accent),#d48a00);
    border:none;border-radius:10px;color:#000;
    font-size:1rem;font-weight:800;cursor:pointer;transition:opacity .2s;
  }
  .btn:hover{opacity:.9}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .spin{
    display:inline-block;width:16px;height:16px;
    border:2px solid #0005;border-top-color:#000;
    border-radius:50%;animation:spin .6s linear infinite;
    vertical-align:middle;margin-left:6px;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-box{
    margin-top:22px;padding:16px;border-radius:12px;
    background:rgba(0,0,0,.4);border:1px solid var(--border);
    text-align:center;display:none;
  }
  .status-box.show{display:block}
  .status-box.waiting{border-color:var(--blue)}
  .status-box.success{border-color:var(--green)}
  .status-box.error{border-color:var(--red)}
  .status-icon{font-size:2rem;display:block;margin-bottom:8px}
  .pair-code{
    font-size:2.8rem;font-weight:900;letter-spacing:7px;
    font-family:monospace;
    background:linear-gradient(135deg,var(--accent),var(--blue));
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;
    background-clip:text;animation:pulse 1.5s ease-in-out infinite;margin:8px 0;
  }
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.7}}
  .hint{color:var(--muted);font-size:.82rem;line-height:1.5;margin-top:8px}
  .hint b{color:var(--accent)}
  .connected-num{font-size:1.3rem;font-weight:700;color:var(--green);margin:6px 0;direction:ltr}
  .divider{border:none;border-top:1px solid var(--border);margin:24px 0}
  .steps{color:var(--muted);font-size:.82rem;line-height:1.9;text-align:right}
  .steps span{color:var(--accent);font-weight:700;margin-left:6px}
  .qr-img{max-width:200px;border-radius:12px;margin:10px auto;display:block}
  .try-again{
    margin-top:12px;background:none;border:1.5px solid var(--border);
    color:var(--muted);padding:9px 18px;border-radius:8px;
    cursor:pointer;font-size:.85rem;width:100%;
  }
  .try-again:hover{border-color:var(--accent);color:var(--accent)}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <span class="icon">🤖</span>
    <h1>Sahil 804 Bot</h1>
    <p>WhatsApp Bot — Pair Code System</p>
  </div>

  <label class="label">📱 اپنا WhatsApp نمبر درج کریں (Country Code کے ساتھ)</label>
  <input class="inp" id="phoneInput" type="tel"
    placeholder="923001234567" dir="ltr"
    oninput="clearErr()" onkeydown="if(event.key==='Enter')startPair()">
  <button class="btn" id="pairBtn" onclick="startPair()">
    🔑 Pair Code حاصل کریں
  </button>

  <div class="status-box" id="statusBox">
    <span class="status-icon" id="statusIcon">⏳</span>
    <div id="statusMsg"></div>
    <button class="try-again" id="tryAgainBtn" style="display:none" onclick="resetUI()">
      🔄 دوبارہ کوشش کریں
    </button>
  </div>

  <hr class="divider">
  <div class="steps">
    <div><span>1️⃣</span> اوپر اپنا نمبر ڈالیں</div>
    <div><span>2️⃣</span> Pair Code حاصل کریں</div>
    <div><span>3️⃣</span> WhatsApp کھولیں</div>
    <div><span>4️⃣</span> <b>Linked Devices → Link a Device → Link with phone number</b></div>
    <div><span>5️⃣</span> Pair Code درج کریں — Bot Connect! ✅</div>
  </div>
</div>

<script>
const BASE    = window.location.origin;
const WS_BASE = BASE.replace(/^http/, 'ws');
let ws = null;

function show(type, icon, html) {
  const box = document.getElementById('statusBox');
  box.className = 'status-box show ' + type;
  document.getElementById('statusIcon').textContent = icon;
  document.getElementById('statusMsg').innerHTML = html;
}

function clearErr() {
  const box = document.getElementById('statusBox');
  if (box.classList.contains('error')) resetUI(true);
}

function resetUI(soft) {
  if (ws) { try { ws.close(); } catch(_){} ws = null; }
  if (!soft) {
    document.getElementById('phoneInput').value = '';
    document.getElementById('phoneInput').focus();
  }
  document.getElementById('statusBox').className = 'status-box';
  document.getElementById('pairBtn').disabled = false;
  document.getElementById('pairBtn').innerHTML = '🔑 Pair Code حاصل کریں';
  document.getElementById('tryAgainBtn').style.display = 'none';
}

async function startPair() {
  const num = document.getElementById('phoneInput').value.trim().replace(/[^0-9]/g, '');
  if (num.length < 10) {
    show('error', '⚠️', '<div style="color:#ef4444">Country Code کے ساتھ نمبر درج کریں<br><small>مثال: 923001234567</small></div>');
    document.getElementById('tryAgainBtn').style.display = 'block';
    return;
  }

  const btn = document.getElementById('pairBtn');
  btn.disabled = true;
  btn.innerHTML = 'کوشش جاری ہے... <span class="spin"></span>';
  show('waiting', '📡', '<div style="color:#3b82f6">Server سے رابطہ ہو رہا ہے...</div>');

  try {
    const resp = await fetch(BASE + '/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: num }),
    });
    const data = await resp.json();

    if (!resp.ok || !data.success) {
      show('error', '❌', '<div style="color:#ef4444">' + (data.error || 'Server Error') + '</div>');
      document.getElementById('tryAgainBtn').style.display = 'block';
      btn.disabled = false;
      btn.innerHTML = '🔑 Pair Code حاصل کریں';
      return;
    }

    show('waiting', '⏳', '<div style="color:#3b82f6">Pair Code تیار ہو رہا ہے...<br><small>WhatsApp سے کنیکٹ ہو رہا ہے</small></div>');
    connectWS(data.sessionId);

  } catch (err) {
    show('error', '❌', '<div style="color:#ef4444">Server سے رابطہ نہیں ہو سکا</div>');
    document.getElementById('tryAgainBtn').style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '🔑 Pair Code حاصل کریں';
  }
}

function connectWS(sessionId) {
  if (ws) { try { ws.close(); } catch(_){} }
  ws = new WebSocket(WS_BASE + '/ws?sessionId=' + sessionId);

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch(_) { return; }

    if (msg.type === 'pairCode') {
      show('success', '🔑',
        '<div style="color:#22c55e;font-size:.85rem;margin-bottom:4px">Pair Code تیار ہے!</div>' +
        '<div class="pair-code">' + (msg.code || '') + '</div>' +
        '<div class="hint">WhatsApp → <b>Linked Devices</b> → <b>Link a Device</b> → <b>Link with phone number</b> → یہ کوڈ درج کریں</div>'
      );
      document.getElementById('tryAgainBtn').style.display = 'block';
      document.getElementById('tryAgainBtn').textContent = '🔄 نیا Pair Code لیں';
    }
    else if (msg.type === 'qr') {
      show('waiting', '📷',
        '<div style="color:#f0a500;margin-bottom:8px">QR Code اسکین کریں:</div>' +
        '<img class="qr-img" src="' + msg.qr + '" alt="QR">' +
        '<div class="hint">WhatsApp → <b>Linked Devices</b> → <b>Link a Device</b> → QR اسکین کریں</div>'
      );
    }
    else if (msg.type === 'connected') {
      show('success', '✅',
        '<div style="color:#22c55e;font-weight:700;font-size:1rem">Bot کامیابی سے Connect ہو گیا! 🎉</div>' +
        '<div class="connected-num">📱 +' + (msg.number || '') + '</div>' +
        '<div class="hint">آپ کا Sahil 804 Bot اب چل رہا ہے۔</div>'
      );
      document.getElementById('tryAgainBtn').style.display = 'block';
      document.getElementById('tryAgainBtn').textContent = '➕ نیا Bot Connect کریں';
    }
    else if (msg.type === 'pairError') {
      show('error', '❌', '<div style="color:#ef4444">Pair Error: ' + (msg.error || 'Unknown') + '</div>');
      document.getElementById('tryAgainBtn').style.display = 'block';
      const btn = document.getElementById('pairBtn');
      btn.disabled = false;
      btn.innerHTML = '🔑 Pair Code حاصل کریں';
    }
    else if (msg.type === 'disconnected') {
      show('error', '📴', '<div style="color:#ef4444">Bot disconnect ہو گیا</div>');
      document.getElementById('tryAgainBtn').style.display = 'block';
      const btn = document.getElementById('pairBtn');
      btn.disabled = false;
      btn.innerHTML = '🔑 Pair Code حاصل کریں';
    }
  };

  ws.onerror = () => {
    show('error', '❌', '<div style="color:#ef4444">Connection Error — دوبارہ کوشش کریں</div>');
    document.getElementById('tryAgainBtn').style.display = 'block';
    const btn = document.getElementById('pairBtn');
    btn.disabled = false;
    btn.innerHTML = '🔑 Pair Code حاصل کریں';
  };
}
</script>
</body>
</html>`);
});

// ─── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info('🚀 Sahil 804 Bot Server running on port ' + PORT);
  logger.info('🔑 Pair Code System Active — No Login Required');
});
        
