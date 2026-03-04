/**
 * JETPESA Unified Local Dev Server
 * ─────────────────────────────────────────────────────────────────
 *  Port 3000  →  Player app   (cashpoa.com/)
 *  Port 3001  →  Admin panel  (cashpoa.com admin/cashpoa.com/)
 *
 *  Both servers share ONE game loop and ONE SSE broadcast set.
 *  Admin Supabase calls are intercepted by a tiny fetch-patcher
 *  script injected into every admin HTML page and served locally.
 *
 *  Run: node server.js
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ─── MegaPay Config ───────────────────────────────────────────────────────────
const MEGAPAY_API_KEY = process.env.MEGAPAY_API_KEY || 'MGPYQGu8Q8f6';
const MEGAPAY_EMAIL   = process.env.MEGAPAY_EMAIL   || 'joramkimani25@gmail.com';
const MEGAPAY_STK_URL = 'https://megapay.co.ke/backend/v1/initiatestk';
const MEGAPAY_STATUS_URL = 'https://megapay.co.ke/backend/v1/transactionstatus';

const MODE        = process.env.MODE || 'both'; // 'player' | 'admin' | 'both'
const IS_RAILWAY  = !!process.env.RAILWAY_ENVIRONMENT;
const PLAYER_PORT = process.env.PORT || 3000;
const SIGNAL_PORT = 3001;
const ADMIN_PORT  = MODE === 'admin' ? (process.env.PORT || 3002) : 3002;
const PLAYER_DIR  = path.join(__dirname, 'cashpoa.com');
const ADMIN_DIR   = path.join(__dirname, 'cashpoa.com admin', 'cashpoa.com');

// ─── MIME Types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
};

// ─── Game Config ──────────────────────────────────────────────────────────────
// ─── Cryptographic crash point generator ─────────────────────────────────────
// Weighted: ~15% instant (1.01-2x), ~40% sweet (2-20x), ~25% mid (20-60x), ~12% high (60-150x), ~8% moon (150-550x)
function generateCrashPoint() {
  const rand = crypto.randomBytes(4).readUInt32BE() / 0xFFFFFFFF;
  const fine = crypto.randomBytes(4).readUInt32BE() / 0xFFFFFFFF;
  let value;
  if (rand < 0.15)       value = 1.01 + fine * 0.99;    // instant crash 1.01-2.0x
  else if (rand < 0.55)  value = 2.0  + fine * 18.0;    // sweet spot   2.0-20.0x
  else if (rand < 0.80)  value = 20   + fine * 40;      // mid          20-60x
  else if (rand < 0.92)  value = 60   + fine * 90;      // high         60-150x
  else                   value = 150  + fine * 400;      // moon         150-550x
  return parseFloat(value.toFixed(2));
}

// ─── Pre-generated crash queue (signal page reads from this) ─────────────────
// Always keeps 10+ upcoming crash points ready so signal page shows REAL values
const QUEUE_SIZE = 10;
const crashQueue = [];   // [{id, multiplier}]
function fillQueue() {
  while (crashQueue.length < QUEUE_SIZE) {
    crashQueue.push({ id: crypto.randomUUID(), multiplier: generateCrashPoint() });
  }
}
fillQueue(); // pre-fill on startup

// Secret signal key — only someone who knows this can see upcoming crash values
const SIGNAL_SECRET = crypto.randomBytes(16).toString('hex');

const DOMAIN_ID  = 'ef4fa632-149c-4556-a356-cd762746d350';
const ALGORITHM  = 'greedy_1.05';
const WAIT_MS    = 8000;   // 8 s countdown
const CRASH_PAUSE= 5000;   // 5 s after crash
const TICK_MS    = 100;    // 100 ms tick rate

function getMultiplierAtTime(seconds) {
  return Math.round(100 * (1 + 0.0055 * Math.pow(seconds, 2.2))) / 100;
}

// Pull the next crash point from front of queue (real value)
function nextCrashPoint() {
  if (crashQueue.length === 0) fillQueue();
  const entry = crashQueue.shift();
  fillQueue(); // refill
  return entry.multiplier;
}

// Peek at the REAL upcoming crash points (what signal page sees)
function peekQueue(count = 5) {
  fillQueue();
  return crashQueue.slice(0, count).map(entry => ({
    id: entry.id,
    multiplier: entry.multiplier,
    status: 'pending',
    created_at: new Date().toISOString(),
    domain_id: DOMAIN_ID,
    server_seed: null,
    hash: null,
  }));
}

// ─── History ──────────────────────────────────────────────────────────────────
const history = [
  47.32, 123.53, 34.1, 29.14, 526.48, 28.12, 29.92,
  16.8, 82.2, 24.6, 151.9, 21.22, 19.46, 339.22,
].map(multiplier => ({
  id: crypto.randomUUID(),
  multiplier,
  timestamp: new Date(Date.now() - Math.random() * 120 * 60000).toISOString(),
  hash: null,
  server_seed: crypto.randomUUID(),
}));

// ─── Game State ───────────────────────────────────────────────────────────────
let game = {
  roundId:       crypto.randomUUID(),
  status:        'waiting',   // 'waiting' | 'flying' | 'crashed'
  multiplier:    1,
  startTime:     null,
  crashPoint:    nextCrashPoint(),
  nextEventTime: Date.now() + WAIT_MS,
};

// ─── Domain Settings (admin-editable at runtime) ──────────────────────────────
let domainSettings = {
  id: DOMAIN_ID,
  domain: 'JetPesa.com',
  brand_name: 'JETPESA',
  signal_url: 'sig',
  primary_color: '#000000',
  logo_url: '',
  payment_option: 'megapay',
  payment_option_config: { email: 'joeljujuu@gmail.com', api_key: 'MGPYPHcAsN7R' },
  enabledGameKeys: ['aviator'],
  enabled_game_keys: ['aviator'],
  min_crash_point: 15,
  instant_crash_pct: 33,
  platform_fee_balance: 0,
  is_active: true,
  spin_config: {
    mode: 'balanced', max_win: 1000,
    segments: [
      { color: '#ff0000', label: '0x',  value: 0,  weight: 50 },
      { color: '#00ff00', label: '2x',  value: 2,  weight: 30 },
      { color: '#0000ff', label: '5x',  value: 5,  weight: 15 },
      { color: '#ffff00', label: '10x', value: 10, weight: 5  },
    ],
    win_chance: 45,
  },
  crash_algorithm_id: 'afc653b0-29a9-4bc8-a424-e60191853f4c',
  game_mode_id: null,
  theme_id: null,
  organization_id: '7cff2a41-55ab-4e14-bbfb-ea0c977e2fe6',
  payment_settings: null,
  created_at: '2026-01-22T18:50:15.448743+00:00',
  updated_at: new Date().toISOString(),
};

const gameModes = [{
  id: '570b6b6e-b372-475a-9f6c-dbd64fcc96cf',
  key: 'impossible',
  name: 'House Always Wins',
  description: 'If there is one bet, the plane crashes at 1.00. If there is more than 1 bet, the first user to attempt a cashout crashes the plane for everyone.',
  win_chance: '0%',
  is_default: true,
  created_at: '2026-01-17T01:12:13.609288+00:00',
}];

const themes = [
  { id: '0faf5cab-9720-4d0b-9d51-dcc79702a984', key: 'aviator',    name: 'Classic Aviator', description: 'The classic plane theme',                      assets: { type: 'plane', background: 'space' },    created_at: '2026-01-17T01:00:47.201052+00:00' },
  { id: '71816169-71df-4c6f-93ef-133c2358ad8d', key: 'motorcycle', name: 'Neon Rider',      description: 'Futuristic motorcycle climbing a mountain', assets: { type: 'bike',  background: 'mountain' }, created_at: '2026-01-17T01:00:47.201052+00:00' },
  { id: '02baacf3-8de3-430c-b7d3-332e21f9e89e', key: 'desert',     name: 'Desert Rally',    description: null,                                        assets: { primaryColor: '#eab308', backgroundImage: '/images/desert-bg.png' }, created_at: '2026-01-17T09:37:45.68303+00:00' },
];

// ─── SSE Clients ──────────────────────────────────────────────────────────────
const clients = new Set();

function sendSSE(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch { clients.delete(res); }
}

function broadcast(event, data) {
  for (const c of clients) sendSSE(c, event, data);
}

// ─── JSON File Database ───────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) { console.error('[DB] Load error:', e.message); }
  return { users: {}, tokens: {}, transactions: [] };
}

function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('[DB] Save error:', e.message); }
}

let db = loadDB();

// ─── User helpers (persistent) ────────────────────────────────────────────────
const users = new Map(); // token → user (runtime cache)

// Rehydrate in-memory token map from DB on startup
for (const [userId, u] of Object.entries(db.users)) {
  if (u.accessToken) users.set(u.accessToken, u);
}

function normalizePhone(raw) {
  let p = String(raw || '').replace(/\s+/g, '').replace(/^\+/, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  // Handle bare number without country code (e.g. 712345678)
  if (p.length === 9 && /^[17]/.test(p)) p = '254' + p;
  return p;
}

function createUser(phone, username) {
  phone = normalizePhone(phone);
  // Check if phone already registered
  const existing = Object.values(db.users).find(u => u.phone === phone);
  if (existing) return { error: 'Phone number already registered. Please log in.' };

  const id    = crypto.randomUUID();
  const token = 'tok_' + crypto.randomBytes(16).toString('hex');
  const user  = {
    id, username: username || `user_${phone.slice(-4)}`,
    phone, email: null,
    balance: 0,
    referralCode: 'JET' + Math.random().toString(36).substring(2, 6).toUpperCase(),
    accessToken: token,
    refreshToken: 'refresh_' + crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  db.users[id] = user;
  users.set(token, user);
  saveDB(db);
  console.log(`[DB] New user: ${user.username} (${phone})`);
  return user;
}

function loginUser(phone) {
  phone = normalizePhone(phone);
  const user = Object.values(db.users).find(u => u.phone === phone);
  if (!user) return { error: 'No account found with this phone number. Please sign up.' };
  // Rotate token on login
  const oldToken = user.accessToken;
  users.delete(oldToken);
  const newToken = 'tok_' + crypto.randomBytes(16).toString('hex');
  user.accessToken = newToken;
  user.refreshToken = 'refresh_' + crypto.randomBytes(8).toString('hex');
  users.set(newToken, user);
  db.users[user.id] = user;
  saveDB(db);
  console.log(`[DB] Login: ${user.username} (${phone})`);
  return user;
}

function getUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  return users.get(token) || null;
}

function persistUser(user) {
  db.users[user.id] = user;
  saveDB(db);
}

function addTransaction(userId, type, amount, details) {
  const tx = {
    id: crypto.randomUUID(),
    userId,
    type,       // 'deposit' | 'withdrawal' | 'bet' | 'cashout'
    amount,
    details: details || '',
    timestamp: new Date().toISOString(),
  };
  db.transactions.push(tx);
  saveDB(db);
  return tx;
}

function getUserTransactions(userId) {
  return db.transactions.filter(t => t.userId === userId).reverse();
}

// ─── Pending Deposits (keyed by transaction_request_id) ──────────────────────
// Persisted in db.json so they survive Railway redeploys
if (!db.pendingDeposits) { db.pendingDeposits = {}; saveDB(db); }
const pendingDeposits = {
  set(key, val) { db.pendingDeposits[key] = val; saveDB(db); },
  get(key) { return db.pendingDeposits[key] || null; },
  delete(key) { delete db.pendingDeposits[key]; saveDB(db); },
  has(key) { return !!db.pendingDeposits[key]; },
  entries() { return Object.entries(db.pendingDeposits); },
};

// ─── Game Loop ────────────────────────────────────────────────────────────────
function startWaiting() {
  const cp  = nextCrashPoint();
  const rid = crypto.randomUUID();
  const nextTime = Date.now() + WAIT_MS;

  game = { roundId: rid, status: 'waiting', multiplier: 1,
           startTime: null, crashPoint: cp, nextEventTime: nextTime };

  broadcast('round_start', {
    roundId: rid, nextEventTime: nextTime,
    predeterminedTarget: cp, queue: peekQueue(), algorithmKey: ALGORITHM,
  });
  broadcast('heartbeat', { status: 'WAITING', nextEventTime: nextTime });
  console.log(`\n[WAIT]   ${rid.slice(0, 8)} | crash @ ${cp}x | fly in ${WAIT_MS / 1000}s`);
  setTimeout(startFlying, WAIT_MS);
}

function startFlying() {
  const { roundId, crashPoint } = game;
  const startTime = Date.now();

  game.status     = 'flying';
  game.startTime  = startTime;
  game.multiplier = 1;
  game.nextEventTime = null;

  broadcast('fly', { roundId, startTime, target: crashPoint, algorithmKey: ALGORITHM });
  console.log(`[FLY]    ${roundId.slice(0, 8)} | target: ${crashPoint}x`);

  const timer = setInterval(() => {
    if (game.status !== 'flying' || game.roundId !== roundId) { clearInterval(timer); return; }
    const elapsed = (Date.now() - startTime) / 1000;
    const mult    = getMultiplierAtTime(elapsed);
    game.multiplier = mult;
    broadcast('tick', { roundId, multiplier: mult, elapsed: Date.now() - startTime, target: crashPoint, timestamp: Date.now() });
    if (mult >= crashPoint) { clearInterval(timer); doCrash(roundId, Math.min(mult, crashPoint)); }
  }, TICK_MS);
}

function doCrash(roundId, finalMult) {
  game.status     = 'crashed';
  game.multiplier = finalMult;
  const nextTime  = Date.now() + CRASH_PAUSE;
  game.nextEventTime = nextTime;

  history.unshift({ id: roundId, multiplier: finalMult,
                    timestamp: new Date().toISOString(),
                    hash: null, server_seed: crypto.randomUUID() });
  if (history.length > 20) history.pop();

  broadcast('crash', { roundId, multiplier: finalMult, nextEventTime: nextTime });
  console.log(`[CRASH]  ${roundId.slice(0, 8)} @ ${finalMult.toFixed(2)}x`);
  setTimeout(startWaiting, CRASH_PAUSE);
}

startWaiting();
setInterval(() => broadcast('heartbeat', { status: game.status.toUpperCase(), nextEventTime: game.nextEventTime }), 10000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readBody(req, cb) {
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => { try { cb(JSON.parse(raw || '{}')); } catch { cb({}); } });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function gameStatePayload() {
  return {
    serverTime: new Date().toISOString(),
    round: {
      id: game.roundId,
      crash_multiplier: game.status === 'crashed' ? game.multiplier : null,
      status: game.status,
      started_at: game.startTime ? new Date(game.startTime).toISOString() : null,
      crashed_at: null,
      created_at: new Date().toISOString(),
      is_demo: false, user_id: null, server_seed: null,
      client_seed: 'worker_v1', domain_id: DOMAIN_ID, hash: null,
    },
    currentMultiplier: game.multiplier,
    startTime: game.startTime,
    history,
    queue: peekQueue(),
    nextEventTime: game.nextEventTime,
    nextEventType: game.status === 'waiting' ? 'FLY' : 'COUNTDOWN',
    target: game.crashPoint,
    predeterminedTarget: game.crashPoint,
    betCount: 0,
    algorithmKey: ALGORITHM,
  };
}

// ─── Shared API handler (used by both servers) ────────────────────────────────
function handleAPI(pathname, req, res) {
  if (pathname === '/api/health') {
    res.writeHead(200); res.end('OK'); return true;
  }

  // ── Signal dashboard (available on /signal on any port) ──────────────────
  if (pathname === '/signal') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(signalDashboardHTML()); return true;
  }
  if (pathname === '/signal/data') {
    fillQueue();
    const current = { roundId: game.roundId, status: game.status, crashPoint: game.crashPoint, multiplier: game.multiplier };
    const upcoming = crashQueue.map((e, i) => ({ position: i + 1, multiplier: e.multiplier }));
    json(res, { current, upcoming }); return true;
  }

  // Placeholder for missing promo images
  if (pathname.startsWith('/images/promo/')) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" rx="16" fill="#111827"/><text x="200" y="90" text-anchor="middle" fill="white" font-family="Arial" font-size="24" font-weight="bold">Welcome to JETPESA!</text><text x="200" y="130" text-anchor="middle" fill="#9ca3af" font-family="Arial" font-size="14">Deposit &amp; Start Winning</text></svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(svg); return true;
  }

  // ── Terms & Conditions page ────────────────────────────────────────────────
  if (pathname === '/terms') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terms of Use – JETPESA</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;line-height:1.7}
.wrap{max-width:720px;margin:0 auto;padding:32px 20px 60px}
.back{display:inline-flex;align-items:center;gap:6px;color:#10b981;text-decoration:none;font-size:14px;margin-bottom:24px}
.back:hover{text-decoration:underline}
h1{font-size:28px;font-weight:700;color:#fff;margin-bottom:4px}
.updated{font-size:13px;color:#888;margin-bottom:32px}
h2{font-size:18px;color:#10b981;margin:28px 0 8px;font-weight:600}
p,li{font-size:15px;color:#ccc;margin-bottom:10px}
ul{padding-left:24px;margin-bottom:12px}
li{margin-bottom:6px}
.footer{text-align:center;margin-top:48px;padding-top:24px;border-top:1px solid #1e1e2e;font-size:13px;color:#555}
</style>
</head>
<body>
<div class="wrap">
<a class="back" href="javascript:void(0)" onclick="if(history.length>1){history.back()}else{location.href='/'}">&#8592; Back</a>
<h1>Terms of Use</h1>
<p class="updated">Last updated: February 2026</p>

<h2>1. Acceptance of Terms</h2>
<p>By accessing or using our platform, you agree to be bound by these Terms of Use. If you do not agree to these terms, please do not use our services.</p>

<h2>2. Eligibility</h2>
<p>You must be at least 18 years of age to use this platform. By using our services, you represent and warrant that you are of legal age in your jurisdiction to form a binding contract.</p>

<h2>3. Account Registration</h2>
<p>When you create an account, you must provide accurate and complete information. You are responsible for maintaining the security of your account credentials and for all activities that occur under your account.</p>

<h2>4. Responsible Gaming</h2>
<p>We encourage responsible gaming. Please set limits for yourself and never bet more than you can afford to lose. If you feel you may have a gambling problem, please seek help from appropriate resources.</p>

<h2>5. Deposits and Withdrawals</h2>
<p>All deposits and withdrawals are subject to our payment processing policies. We reserve the right to verify your identity before processing any transactions. Minimum deposit and withdrawal amounts may apply.</p>

<h2>6. Game Rules</h2>
<p>Each game has its own set of rules. By participating in any game, you agree to abide by those rules. The outcome of all games is determined by our certified random number generator.</p>

<h2>7. Prohibited Activities</h2>
<p>You agree not to engage in any of the following activities:</p>
<ul>
<li>Using automated software or bots</li>
<li>Colluding with other users</li>
<li>Exploiting bugs or errors in the platform</li>
<li>Money laundering or fraudulent activities</li>
<li>Creating multiple accounts</li>
</ul>

<h2>8. Limitation of Liability</h2>
<p>We are not liable for any losses incurred while using our platform. All games involve risk, and you play at your own discretion. We do not guarantee any winnings or outcomes.</p>

<h2>9. Changes to Terms</h2>
<p>We reserve the right to modify these terms at any time. Continued use of the platform after changes constitutes acceptance of the new terms.</p>

<h2>10. Contact Us</h2>
<p>If you have any questions about these Terms of Use, please contact our support team.</p>

<div class="footer">&copy; 2026 JETPESA. All rights reserved.</div>
</div>
</body>
</html>`);
    return true;
  }

  // ── Profile page ───────────────────────────────────────────────────────────
  if (pathname === '/profile') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Profile – JETPESA</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif;line-height:1.7}
.wrap{max-width:480px;margin:0 auto;padding:32px 20px 60px}
.back{display:inline-flex;align-items:center;gap:6px;color:#10b981;text-decoration:none;font-size:14px;margin-bottom:24px}
.back:hover{text-decoration:underline}
h1{font-size:26px;font-weight:700;color:#fff;margin-bottom:24px}
.avatar{width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#10b981,#059669);display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:#fff;margin:0 auto 20px}
.card{background:#12121a;border:1px solid #1e1e2e;border-radius:12px;padding:20px;margin-bottom:16px}
.card-title{font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #1e1e2e}
.row:last-child{border-bottom:none}
.row-label{font-size:14px;color:#999}
.row-value{font-size:14px;color:#fff;font-weight:500}
.balance-box{text-align:center;padding:24px;background:linear-gradient(135deg,#10b98120,#05966910);border:1px solid #10b98140;border-radius:12px;margin-bottom:16px}
.balance-label{font-size:13px;color:#888;margin-bottom:4px}
.balance-amount{font-size:36px;font-weight:700;color:#10b981}
.balance-currency{font-size:16px;color:#999;margin-left:4px}
.referral-box{text-align:center;padding:16px;background:#1a1a2e;border:1px dashed #10b98160;border-radius:12px;margin-bottom:16px}
.referral-code{font-size:22px;font-weight:700;color:#10b981;letter-spacing:2px;margin:8px 0}
.referral-label{font-size:13px;color:#888}
.copy-btn{background:#10b981;color:#000;border:none;padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:8px}
.copy-btn:hover{background:#059669}
.btn-row{display:flex;gap:10px;margin-top:20px}
.btn{flex:1;padding:14px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn-deposit{background:#10b981;color:#000}
.btn-deposit:hover{background:#059669}
.btn-logout{background:#1e1e2e;color:#ef4444;border:1px solid #ef444440}
.btn-logout:hover{background:#ef444420}
.not-logged-in{text-align:center;padding:60px 20px;color:#888}
.not-logged-in a{color:#10b981}
.footer{text-align:center;margin-top:32px;font-size:12px}
.footer a{color:#888;text-decoration:none;margin:0 8px}
.footer a:hover{color:#10b981}
</style>
</head>
<body>
<div class="wrap">
<a class="back" href="javascript:void(0)" onclick="if(history.length>1){history.back()}else{location.href='/'}">&#8592; Back</a>
<h1>My Profile</h1>

<div id="logged-out" class="not-logged-in" style="display:none">
  <p>You are not logged in.</p>
  <p><a href="/">Go to Home</a> to sign in.</p>
</div>

<div id="profile" style="display:none">
  <div class="avatar" id="avatar-init">?</div>

  <div class="balance-box">
    <div class="balance-label">Wallet Balance</div>
    <div><span class="balance-amount" id="p-balance">0</span><span class="balance-currency">KES</span></div>
  </div>

  <div class="card">
    <div class="card-title">Account Info</div>
    <div class="row"><span class="row-label">Username</span><span class="row-value" id="p-username">—</span></div>
    <div class="row"><span class="row-label">Phone</span><span class="row-value" id="p-phone">—</span></div>
    <div class="row"><span class="row-label">Email</span><span class="row-value" id="p-email">—</span></div>
    <div class="row"><span class="row-label">User ID</span><span class="row-value" id="p-id" style="font-size:11px;word-break:break-all">—</span></div>
  </div>

  <div class="referral-box">
    <div class="referral-label">Your Referral Code</div>
    <div class="referral-code" id="p-referral">—</div>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('p-referral').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy Code',1500)">Copy Code</button>
  </div>

  <div class="btn-row">
    <a class="btn btn-deposit" href="/">Deposit</a>
    <button class="btn btn-logout" onclick="localStorage.removeItem('accessToken');localStorage.removeItem('token');location.href='/'">Log Out</button>
  </div>

  <div class="card" id="history-card" style="margin-top:16px;display:none">
    <div class="card-title">Transaction History</div>
    <div id="tx-list" style="max-height:320px;overflow-y:auto"></div>
    <div id="tx-empty" style="text-align:center;color:#666;padding:16px;display:none">No transactions yet</div>
  </div>
</div>

<div class="footer">
  <a href="/terms">Terms of Use</a>
</div>
</div>

<script>
(function(){
  var token = localStorage.getItem('accessToken') || localStorage.getItem('token') || '';
  if (!token) { document.getElementById('logged-out').style.display='block'; return; }
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.error || !d.user) { document.getElementById('logged-out').style.display='block'; return; }
      var u = d.user, w = d.wallet || {};
      document.getElementById('p-username').textContent = u.username || '—';
      document.getElementById('p-phone').textContent = u.phone || '—';
      document.getElementById('p-email').textContent = u.email || 'Not set';
      document.getElementById('p-id').textContent = u.id || '—';
      document.getElementById('p-balance').textContent = (w.balance || 0).toLocaleString();
      document.getElementById('p-referral').textContent = u.referralCode || '—';
      var init = (u.username || '?')[0].toUpperCase();
      document.getElementById('avatar-init').textContent = init;
      document.getElementById('profile').style.display = 'block';
      // Load transaction history
      fetch('/api/wallet/history', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(r){ return r.json(); })
        .then(function(txs){
          var card = document.getElementById('history-card');
          var list = document.getElementById('tx-list');
          var empty = document.getElementById('tx-empty');
          card.style.display = 'block';
          if (!txs.length) { empty.style.display = 'block'; return; }
          txs.slice(0, 30).forEach(function(tx){
            var icon = tx.type === 'deposit' ? '💰' : tx.type === 'withdrawal' ? '📤' : tx.type === 'cashout' ? '🎉' : '🎲';
            var color = tx.amount >= 0 ? '#10b981' : '#ef4444';
            var sign = tx.amount >= 0 ? '+' : '';
            var date = new Date(tx.timestamp).toLocaleDateString('en-KE', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e1e2e';
            row.innerHTML = '<div><span style=\"margin-right:8px\">'+icon+'</span><span style=\"font-size:13px;color:#ccc;text-transform:capitalize\">'+tx.type+'</span><div style=\"font-size:11px;color:#666;margin-top:2px\">'+date+'</div></div><div style=\"font-size:14px;font-weight:600;color:'+color+'\">'+sign+'KES '+Math.abs(tx.amount).toLocaleString()+'</div>';
            list.appendChild(row);
          });
        }).catch(function(){});
    })
    .catch(function(){ document.getElementById('logged-out').style.display='block'; });
})();
</script>
</body>
</html>`);
    return true;
  }

  if (pathname === '/api/game/state') {
    json(res, gameStatePayload()); return true;
  }

  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    clients.add(res);
    sendSSE(res, 'heartbeat', { status: game.status.toUpperCase(), nextEventTime: game.nextEventTime });
    req.on('close', () => clients.delete(res));
    req.on('error', () => clients.delete(res));
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    readBody(req, body => {
      const phone = body.phone || '';
      if (!phone) { json(res, { error: 'Phone number required' }, 400); return; }
      const result = loginUser(phone);
      if (result.error) { json(res, { error: result.error }, 401); return; }
      json(res, { user: { id: result.id, username: result.username, phone: result.phone, email: result.email, referralCode: result.referralCode }, wallet: { balance: result.balance }, session: { accessToken: result.accessToken, refreshToken: result.refreshToken } });
    }); return true;
  }

  if (pathname === '/api/auth/signup' && req.method === 'POST') {
    readBody(req, body => {
      const phone = body.phone || '';
      if (!phone) { json(res, { error: 'Phone number required' }, 400); return; }
      const result = createUser(phone, body.username || null);
      if (result.error) { json(res, { error: result.error }, 409); return; }
      json(res, { user: { id: result.id, username: result.username, phone: result.phone, email: result.email, referralCode: result.referralCode }, wallet: { balance: result.balance }, session: { accessToken: result.accessToken, refreshToken: result.refreshToken } });
    }); return true;
  }

  if (pathname === '/api/auth/me') {
    const user = getUser(req);
    if (!user) { json(res, { error: 'Unauthorized' }, 401); return true; }
    json(res, { user: { id: user.id, username: user.username, phone: user.phone, email: null, referralCode: user.referralCode }, wallet: { balance: user.balance } });
    return true;
  }

  if (pathname === '/api/game/bet' && req.method === 'POST') {
    readBody(req, body => {
      const user   = getUser(req);
      const amount = Math.min(60, Math.max(10, parseFloat(body.amount) || 10));
      if (amount > 60) { json(res, { success: false, message: 'Maximum bet is 60 KES.' }, 400); return; }
      if (user) {
        if (user.balance < amount) { json(res, { success: false, message: 'Insufficient balance. Please deposit first.' }, 400); return; }
        user.balance = Math.max(0, user.balance - amount);
        persistUser(user);
        addTransaction(user.id, 'bet', -amount, `Round ${game.roundId.slice(0,8)}`);
      }
      json(res, { success: true, bet: { id: crypto.randomUUID(), amount, roundId: game.roundId }, newBalance: user ? user.balance : 0 });
      broadcast('bet_placed', { roundId: game.roundId });
    }); return true;
  }

  if (pathname === '/api/game/cashout' && req.method === 'POST') {
    readBody(req, body => {
      const user   = getUser(req);
      const mult   = parseFloat(body.multiplier) || 1;
      const amount = parseFloat(body.amount) || 10;
      const payout = parseFloat((amount * mult).toFixed(2));
      if (user) {
        user.balance += payout;
        persistUser(user);
        addTransaction(user.id, 'cashout', payout, `${mult}x on ${amount}`);
      }
      json(res, { success: true, payout, newBalance: user ? user.balance : 0 });
    }); return true;
  }

  if (pathname === '/api/referral/settings') {
    json(res, { referrer_bonus: 500, referee_bonus: 0, bonus_trigger: 'first_deposit', is_active: true, banner_text: 'Refer & Earn', banner_description: 'Get bonus when your friend makes their first deposit!' });
    return true;
  }

  if (pathname === '/api/mpesa/stkpush' && req.method === 'POST') {
    readBody(req, body => {
      const user   = getUser(req);
      const amount = parseFloat(body.amount) || 0;
      if (amount < 100) {
        json(res, { success: false, message: 'Minimum deposit is KES 100' }, 400);
        return;
      }
      // Normalize phone: accept 07xx, 2547xx, +2547xx
      let phone = String(body.phone || (user && user.phone) || '').replace(/\s+/g, '');
      if (phone.startsWith('+')) phone = phone.slice(1);
      if (phone.startsWith('0'))  phone = '254' + phone.slice(1);

      if (!phone || phone.length < 12) {
        json(res, { success: false, message: 'Valid phone number required' }, 400);
        return;
      }

      const reference = 'DEP' + Date.now();
      const payload   = JSON.stringify({
        api_key:   MEGAPAY_API_KEY,
        email:     MEGAPAY_EMAIL,
        amount:    String(amount),
        msisdn:    phone,
        reference,
      });

      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      };

      const mpReq = https.request(MEGAPAY_STK_URL, options, mpRes => {
        let raw = '';
        mpRes.on('data', d => raw += d);
        mpRes.on('end', () => {
          let result;
          try { result = JSON.parse(raw); } catch { result = {}; }
          console.log('[MegaPay STK]', result);

          if (result.success === '200' || result.success === 200) {
            // Store pending deposit so webhook can credit the user
            if (user) {
              pendingDeposits.set(result.transaction_request_id, {
                userId: user.id,
                token:  user.accessToken,
                amount,
              });
            }
            json(res, {
              success:              true,
              message:              `STK Push sent to ${phone}. Enter your M-Pesa PIN to complete.`,
              transaction_request_id: result.transaction_request_id,
              CheckoutRequestID:    result.transaction_request_id,
              checkoutRequestId:    result.transaction_request_id,
            });
          } else {
            json(res, { success: false, message: result.message || result.massage || 'Failed to initiate STK push. Try again.' }, 502);
          }
        });
      });

      mpReq.on('error', err => {
        console.error('[MegaPay STK error]', err.message);
        json(res, { success: false, message: 'Could not reach MegaPay. Please try again.' }, 502);
      });
      mpReq.write(payload);
      mpReq.end();
    }); return true;
  }

  // ── MegaPay Webhook (set this URL in your MegaPay dashboard) ───────────────
  // URL: https://jetpesa-production.up.railway.app/api/mpesa/webhook
  if (pathname === '/api/mpesa/webhook' && req.method === 'POST') {
    readBody(req, body => {
      console.log('[MegaPay Webhook]', JSON.stringify(body));

      // Save raw callback to db.json for audit trail
      if (!db.mpesa_callbacks) db.mpesa_callbacks = [];
      db.mpesa_callbacks.push({ ...body, received_at: new Date().toISOString() });
      saveDB(db);

      const code = parseInt(body.ResponseCode);
      if (code === 0) {
        // Look up pending deposit — try every key MegaPay might send
        let matchedKey = null;
        let matched = null;
        const candidates = [body.TransactionID, body.CheckoutRequestID, body.MerchantRequestID].filter(Boolean);
        for (const c of candidates) {
          const p = pendingDeposits.get(c);
          if (p) { matched = p; matchedKey = c; break; }
        }
        // Also iterate all pending entries (our key = transaction_request_id from STK)
        if (!matched) {
          for (const [key, val] of pendingDeposits.entries()) {
            if (candidates.includes(key)) {
              matched = val; matchedKey = key; break;
            }
          }
        }

        if (matched) {
          const user = users.get(matched.token);
          if (user) {
            user.balance += matched.amount;
            persistUser(user);
            // Include matchedKey so status poll "already credited" check can find it
            addTransaction(user.id, 'deposit', matched.amount, `M-Pesa ${body.TransactionReceipt || body.TransactionID || ''} ${matchedKey} via ${body.Msisdn || ''}`);
            console.log(`[MegaPay] Credited KES ${matched.amount} to ${user.username} | new balance: ${user.balance}`);
          }
          // Clean up all possible keys
          if (matchedKey) pendingDeposits.delete(matchedKey);
          for (const c of candidates) pendingDeposits.delete(c);
        } else {
          console.log(`[MegaPay] No pending deposit found for TransactionID=${body.TransactionID} CheckoutRequestID=${body.CheckoutRequestID}`);
        }
      } else {
        console.log(`[MegaPay] Payment failed: ${body.ResponseDescription} (code ${code})`);
        addTransaction('system', 'deposit_failed', parseInt(body.TransactionAmount) || 0, `Failed: ${body.ResponseDescription} | ${body.Msisdn || ''}`);
        const candidates = [body.TransactionID, body.CheckoutRequestID, body.MerchantRequestID].filter(Boolean);
        for (const c of candidates) pendingDeposits.delete(c);
      }
      // Always respond 200 to acknowledge
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'received' }));
    }); return true;
  }

  // ── MegaPay Transaction Status Poll ────────────────────────────────────────
  // Supports both GET /api/mpesa/status?cid=<id> (frontend polls) and POST
  if (pathname === '/api/mpesa/status') {
    const handleStatus = (txReqId) => {
      if (!txReqId) {
        json(res, { status: 'failed', message: 'transaction_request_id required' }, 400);
        return;
      }

      // Check if already credited (pending was removed by webhook)
      if (!pendingDeposits.has(txReqId)) {
        // No pending entry = webhook already credited it OR it was never valid
        // Check if there's a matching transaction in db
        const wasCredited = db.transactions.some(t => t.type === 'deposit' && t.details && t.details.includes(txReqId));
        if (wasCredited) {
          json(res, { status: 'completed', message: 'Payment already confirmed' });
          return;
        }
      }

      const payload = JSON.stringify({
        api_key:                MEGAPAY_API_KEY,
        email:                  MEGAPAY_EMAIL,
        transaction_request_id: txReqId,
      });
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      };
      const mpReq = https.request(MEGAPAY_STATUS_URL, options, mpRes => {
        let raw = '';
        mpRes.on('data', d => raw += d);
        mpRes.on('end', () => {
          let result;
          try { result = JSON.parse(raw); } catch { result = {}; }
          console.log('[MegaPay Status]', JSON.stringify(result));

          // Save status poll response to db.json
          if (!db.mpesa_callbacks) db.mpesa_callbacks = [];
          db.mpesa_callbacks.push({ ...result, source: 'status_poll', received_at: new Date().toISOString() });
          saveDB(db);

          // Determine normalized status for frontend
          // MegaPay may return: success='200' + TransactionStatus + ResultCode
          // IMPORTANT: When polled before user enters PIN, MegaPay returns non-zero ResultCode
          // which does NOT mean failed — it means still processing. Only mark as failed
          // for explicit terminal failure codes.
          const rc = String(result.ResultCode || '');
          const isCompleted = (result.TransactionStatus === 'Completed' || result.success === '200' || result.success === 200) &&
                              (rc === '0' || result.TransactionCode === '0' || result.TransactionCode === 0);
          
          // Only these codes are truly terminal failures (user cancelled, wrong PIN, insufficient funds)
          const terminalFailureCodes = ['1032', '1', '2001', '1037', '1025'];
          // 1032 = cancelled by user, 1 = insufficient funds, 2001 = wrong PIN, 
          // 1037 = timeout (DS), 1025 = limit exceeded
          const isTerminalFail = terminalFailureCodes.includes(rc) && 
                                  result.TransactionStatus !== 'Pending' &&
                                  result.TransactionStatus !== 'Processing';
          
          // Also check if MegaPay says explicitly "The service request is processed successfully" 
          // but ResultCode is not 0 — that means STK was sent but user hasn't responded yet
          const isStillProcessing = result.ResponseDescription === 'The service request is processed successfully.' ||
                                    result.ResponseDescription === 'Success. Request accepted for processing' ||
                                    result.TransactionStatus === 'Pending' ||
                                    result.TransactionStatus === 'Processing' ||
                                    (!result.ResultCode && !result.TransactionStatus);

          if (isCompleted) {
            // Credit user if not yet credited via webhook
            const pending = pendingDeposits.get(txReqId);
            if (pending) {
              const user = users.get(pending.token);
              if (user) {
                user.balance += pending.amount;
                persistUser(user);
                addTransaction(user.id, 'deposit', pending.amount, `M-Pesa ${result.TransactionReceipt || txReqId}`);
                console.log(`[MegaPay Status] Credited KES ${pending.amount} to ${user.username}`);
              }
              pendingDeposits.delete(txReqId);
            }
            json(res, { status: 'completed', result_desc: result.ResultDesc || 'Payment successful' });
          } else if (isStillProcessing) {
            // User hasn't entered PIN yet — keep polling
            json(res, { status: 'pending', result_desc: 'Waiting for you to enter M-Pesa PIN...' });
          } else if (isTerminalFail) {
            pendingDeposits.delete(txReqId);
            json(res, { status: 'failed', result_desc: result.ResultDesc || 'Payment failed or cancelled' });
          } else {
            // Unknown state — treat as pending to keep polling (safe default)
            console.log('[MegaPay Status] Unknown state, treating as pending:', JSON.stringify(result));
            json(res, { status: 'pending', result_desc: result.ResultDesc || 'Waiting for payment confirmation' });
          }
        });
      });
      mpReq.on('error', err => {
        console.error('[MegaPay Status error]', err.message);
        json(res, { status: 'pending', message: 'Could not reach MegaPay, will retry.' });
      });
      mpReq.write(payload);
      mpReq.end();
    };

    if (req.method === 'GET') {
      // Frontend polls: GET /api/mpesa/status?cid=<transaction_request_id>
      const fullUrl = new URL(req.url, `http://${req.headers.host}`);
      handleStatus(fullUrl.searchParams.get('cid') || fullUrl.searchParams.get('transaction_request_id'));
    } else {
      readBody(req, body => {
        handleStatus(body.transaction_request_id || body.cid);
      });
    }
    return true;
  }

  if (pathname === '/api/wallet/withdraw' && req.method === 'POST') {
    readBody(req, body => {
      const amount = parseFloat(body.amount) || 100;
      const user   = getUser(req);
      if (!user) { json(res, { success: false, message: 'Unauthorized' }, 401); return; }
      if (user.balance < amount) { json(res, { success: false, message: 'Insufficient balance' }, 400); return; }
      user.balance = Math.max(0, user.balance - amount);
      persistUser(user);
      addTransaction(user.id, 'withdrawal', -amount, `Withdraw KES ${amount}`);
      json(res, { success: true, message: `KES ${amount} withdrawal queued`, newBalance: user.balance });
    }); return true;
  }

  // ── Transaction history ────────────────────────────────────────────────────
  if (pathname === '/api/wallet/history') {
    const user = getUser(req);
    if (!user) { json(res, { error: 'Unauthorized' }, 401); return true; }
    json(res, getUserTransactions(user.id));
    return true;
  }

  if (pathname === '/api/broadcast' && req.method === 'POST') {
    readBody(req, body => {
      if (body.event && body.data) broadcast(body.event, body.data);
      json(res, { ok: true });
    }); return true;
  }

  // ── Admin-only: force a crash at a specific multiplier ─────────────────────
  if (pathname === '/api/admin/force-crash' && req.method === 'POST') {
    readBody(req, body => {
      const at = parseFloat(body.at) || 1.5;
      if (game.status === 'flying') {
        doCrash(game.roundId, at);
        json(res, { ok: true, crashed_at: at });
      } else {
        json(res, { ok: false, error: `Game is not flying (current: ${game.status})` }, 400);
      }
    }); return true;
  }

  // ── Admin-only: inject specific crash values into the queue ────────────────
  if (pathname === '/api/admin/crash-pool' && req.method === 'POST') {
    readBody(req, body => {
      if (Array.isArray(body.pool) && body.pool.length > 0) {
        // Clear queue and inject the provided values at the front
        crashQueue.length = 0;
        body.pool.forEach(x => crashQueue.push({ id: crypto.randomUUID(), multiplier: parseFloat(x) }));
        fillQueue(); // pad with random values after the injected ones
        console.log('[Admin] Queue injected:', crashQueue.slice(0, 5).map(e => e.multiplier), '...');
        json(res, { ok: true, queue: crashQueue.map(e => e.multiplier) });
      } else {
        json(res, { ok: false, error: 'Provide { pool: [number, ...] }' }, 400);
      }
    }); return true;
  }

  // ── Secret Signal API — shows upcoming crash values ────────────────────────
  // Access: /api/signal?key=<SIGNAL_SECRET>
  if (pathname === '/api/signal') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = url.searchParams.get('key');
    if (key !== SIGNAL_SECRET) {
      json(res, { error: 'Invalid signal key' }, 403); return true;
    }
    fillQueue();
    const current = {
      roundId: game.roundId,
      status: game.status,
      crashPoint: game.crashPoint,
      multiplier: game.multiplier,
    };
    const upcoming = crashQueue.map((e, i) => ({ position: i + 1, id: e.id, multiplier: e.multiplier }));
    json(res, { current, upcoming });
    return true;
  }

  return false; // not handled
}

// ─── Mock Supabase REST endpoints (admin panel) ───────────────────────────────
function handleSupabase(pathname, req, res) {
  if (pathname === '/rest/v1/domain_settings') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      json(res, [domainSettings]); return true;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      readBody(req, body => {
        Object.assign(domainSettings, body, { updated_at: new Date().toISOString() });
        console.log('[Admin] domain_settings updated:', Object.keys(body).join(', '));
        json(res, [domainSettings]);
      }); return true;
    }
  }

  if (pathname === '/rest/v1/game_modes') {
    json(res, gameModes); return true;
  }

  if (pathname === '/rest/v1/themes') {
    json(res, themes); return true;
  }

  // User settings stub — frontend queries this after login
  if (pathname === '/rest/v1/user_settings') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      json(res, []); return true; // empty array = no custom settings yet
    }
    if (req.method === 'POST' || req.method === 'PATCH') {
      readBody(req, body => { json(res, [body]); });
      return true;
    }
  }

  // Transactions stub — frontend queries this for wallet history
  if (pathname === '/rest/v1/transactions') {
    const user = getUser(req);
    if (user) {
      const txs = getUserTransactions(user.id).slice(0, 10).map(t => ({
        id: t.id,
        type: t.type,
        amount: Math.abs(t.amount),
        status: 'completed',
        created_at: t.timestamp,
        description: t.details,
      }));
      json(res, txs); return true;
    }
    json(res, []); return true;
  }

  // Catch-all for any other /rest/v1/ routes — return empty array
  if (pathname.startsWith('/rest/v1/')) {
    json(res, []); return true;
  }

  // Supabase auth stub — return a valid session so the app stays logged in
  if (pathname.startsWith('/auth/v1/')) {
    const user = getUser(req);
    if (user) {
      const session = {
        access_token: user.accessToken,
        refresh_token: user.refreshToken,
        token_type: 'bearer',
        expires_in: 86400,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        user: { id: user.id, email: user.email || `${user.phone}@jetpesa.com`, phone: user.phone, role: 'authenticated' },
      };
      // /auth/v1/token?grant_type=refresh_token
      if (pathname.includes('/token')) {
        json(res, session); return true;
      }
      // /auth/v1/session
      json(res, { data: { session }, error: null }); return true;
    }
    // No auth header — return empty session (don't break the app)
    json(res, { data: { session: null }, error: null });
    return true;
  }

  return false;
}

// ─── Fetch-interceptor injected into every admin HTML page ───────────────────
// Rewrites browser calls to xckttcubxhxnueeggzvm.supabase.co → admin server
const ADMIN_PUBLIC_URL = process.env.ADMIN_PUBLIC_URL || `http://localhost:${ADMIN_PORT}`;
const PLAYER_PUBLIC_URL = process.env.PLAYER_PUBLIC_URL || (IS_RAILWAY ? `https://jetpesa-production.up.railway.app` : `http://localhost:${PLAYER_PORT}`);

function makeFetchInterceptor(targetUrl) {
  return `<script>
/* JETPESA: proxy Supabase → local server + session sync */
(function(){
  // Sync our accessToken into Supabase's storage key so getSession() finds it
  var SK='sb-session';
  var at=localStorage.getItem('accessToken');
  if(at && at!=='undefined' && at!=='null'){
    var existing=null;
    try{existing=JSON.parse(localStorage.getItem(SK))}catch(e){}
    if(!existing || existing.access_token!==at){
      var sess={
        access_token:at,
        refresh_token:localStorage.getItem('refreshToken')||at,
        token_type:'bearer',
        expires_in:86400,
        expires_at:Math.floor(Date.now()/1000)+86400,
        user:{id:'user',role:'authenticated'}
      };
      localStorage.setItem(SK,JSON.stringify(sess));
    }
  }

  // Intercept fetch/XHR to redirect Supabase calls to local server
  var H='xckttcubxhxnueeggzvm.supabase.co';
  var L='${targetUrl}';
  var _f=window.fetch.bind(window);
  window.fetch=function(i,o){
    var u=(i instanceof Request)?i.url:String(i);
    if(!o) o={};
    if(!o.headers) o.headers={};
    // Always refresh token from localStorage
    var tok=localStorage.getItem('accessToken');
    // Inject auth header on ALL requests to our server (including /api/ routes)
    if(tok && tok!=='undefined' && tok!=='null'){
      var isOwn=(u.indexOf('/api/')!==-1||u.indexOf('/rest/')!==-1||u.indexOf('/auth/')!==-1||u.indexOf(H)!==-1);
      if(isOwn && !o.headers['Authorization'] && !o.headers['authorization']){
        if(o.headers instanceof Headers){o.headers.set('Authorization','Bearer '+tok)}
        else{o.headers['Authorization']='Bearer '+tok}
      }
    }
    if(u.indexOf(H)!==-1){
      var p=new URL(u);
      var loc=L+p.pathname+p.search;
      i=(i instanceof Request)?new Request(loc,{method:i.method,headers:o.headers||i.headers,body:i.body,mode:'cors',credentials:'omit'}):loc;
    }
    return _f(i,o);
  };
  var _x=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    var a=Array.prototype.slice.call(arguments);
    if(typeof a[1]==='string'&&a[1].indexOf(H)!==-1){
      var p=new URL(a[1]);a[1]=L+p.pathname+p.search;
    }
    return _x.apply(this,a);
  };
})();
</script>`;
}

const FETCH_INTERCEPTOR       = makeFetchInterceptor(ADMIN_PUBLIC_URL);
const PLAYER_FETCH_INTERCEPTOR = makeFetchInterceptor(PLAYER_PUBLIC_URL);

// ─── "Next Game" Overlay ─────────────────────────────────────────────────────
// Full-screen cover that stays visible until a brand-new round starts.
// React runs underneath but the user can't see it, so any stale FLEW-AWAY is hidden.
const SPLASH_SCREEN = `
<style>
  #jp-overlay {
    position:fixed; top:0; left:0; width:100vw; height:100vh; z-index:999999;
    background: radial-gradient(ellipse at center, #1a1a2e 0%, #0a0a0f 70%);
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    transition: opacity 0.6s ease-out;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  #jp-overlay.fade-out { opacity:0; pointer-events:none; }
  #jp-overlay .logo-glow {
    width:90px; height:90px; border-radius:18px;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    display:flex; align-items:center; justify-content:center;
    box-shadow: 0 0 40px rgba(245,158,11,0.4), 0 0 80px rgba(239,68,68,0.2);
    animation: jp-pulse 2s ease-in-out infinite;
    margin-bottom: 20px;
  }
  #jp-overlay .logo-glow svg { width:50px; height:50px; }
  #jp-overlay .brand {
    font-size:30px; font-weight:900; letter-spacing:1px;
    background: linear-gradient(135deg, #f59e0b, #ef4444);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent;
    margin-bottom:6px;
  }
  #jp-overlay .tagline { color:#666; font-size:13px; margin-bottom:28px; }
  #jp-overlay .status {
    color:#ccc; font-size:15px; font-weight:600; margin-bottom:12px;
    min-height:22px; text-align:center;
  }
  #jp-overlay .dots span {
    display:inline-block; width:8px; height:8px; border-radius:50%;
    background:#f59e0b; margin:0 4px; animation: jp-dot 1.4s ease-in-out infinite;
  }
  #jp-overlay .dots span:nth-child(2) { animation-delay:0.2s; }
  #jp-overlay .dots span:nth-child(3) { animation-delay:0.4s; }
  @keyframes jp-pulse {
    0%,100%{box-shadow:0 0 40px rgba(245,158,11,0.4),0 0 80px rgba(239,68,68,0.2)}
    50%{box-shadow:0 0 60px rgba(245,158,11,0.6),0 0 100px rgba(239,68,68,0.3)}
  }
  @keyframes jp-dot {
    0%,80%,100%{transform:scale(0.6);opacity:0.4}
    40%{transform:scale(1);opacity:1}
  }
</style>
<div id="jp-overlay">
  <div class="logo-glow">
    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
    </svg>
  </div>
  <div class="brand">JetPesa</div>
  <div class="tagline">Fly high. Cash out.</div>
  <div class="status" id="jp-status">Connecting...</div>
  <div class="dots"><span></span><span></span><span></span></div>
</div>
<script>
(function(){
  var el=document.getElementById('jp-overlay');
  var statusEl=document.getElementById('jp-status');
  var done=false;

  function hide(){
    if(done)return; done=true;
    if(es){try{es.close()}catch(e){}}
    if(el){el.classList.add('fade-out'); setTimeout(function(){el.remove()},700);}
  }

  /* Open our own SSE connection and wait for the NEXT fresh round */
  var es;
  try{
    es=new EventSource('/api/stream');

    es.addEventListener('round_start',function(){
      statusEl.textContent='Game starting!';
      /* Tiny delay so React also processes round_start before we reveal */
      setTimeout(hide,400);
    });

    es.addEventListener('heartbeat',function(e){
      try{
        var d=JSON.parse(e.data);
        if(d.status==='WAITING'){
          /* User connected during waiting phase.
             The round_start already fired before we connected,
             so we just wait for FLY (plane takeoff). */
          statusEl.textContent='Next game starting soon...';
        } else if(d.status==='FLYING'){
          statusEl.textContent='Game in progress, please wait...';
        } else if(d.status==='CRASHED'){
          statusEl.textContent='Preparing next game...';
        }
      }catch(e){}
    });

    /* If we connect during WAITING, the next event is FLY (plane takes off).
       That means the user will see the FULL flight from the start. Safe to reveal. */
    es.addEventListener('fly',function(){
      statusEl.textContent='Here we go!';
      setTimeout(hide,300);
    });

    es.addEventListener('crash',function(){
      statusEl.textContent='Preparing next game...';
    });

    es.onerror=function(){
      statusEl.textContent='Connecting...';
    };
  }catch(e){}

  /* Absolute fallback: never show overlay for more than 45s */
  setTimeout(hide,45000);
})();
</script>`;

// ─── Static file server ───────────────────────────────────────────────────────
function serveStatic(staticDir, pathname, res, isAdmin) {
  let filePath;

  if (pathname === '/' || pathname === '') {
    // Player root → aviator game; Admin root → sig (operator panel)
    filePath = path.join(staticDir, isAdmin ? 'sig.html' : 'aviator.html');
  } else {
    filePath = path.join(staticDir, pathname);
    // Security: block path traversal
    if (!filePath.startsWith(staticDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  }

  // Directory → try index.html inside
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Extension-less routes (e.g. /sig, /aviator) → try .html
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    const withHtml = filePath + '.html';
    if (fs.existsSync(withHtml)) filePath = withHtml;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 – Not Found: ' + pathname);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    // Inject the Supabase proxy into every HTML page
    if (ext === '.html') {
      let html = data.toString('utf8');
      const interceptor = isAdmin ? FETCH_INTERCEPTOR : PLAYER_FETCH_INTERCEPTOR;
      html = html.replace('<head>', '<head>' + interceptor);
      // Inject JetPesa splash screen for player pages (not admin)
      if (!isAdmin) {
        html = html.replace('<body>', '<body>' + SPLASH_SCREEN);
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(html);
    } else {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
}

// ─── Player server  (port 3000) ───────────────────────────────────────────────
const playerServer = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PLAYER_PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (handleAPI(pathname, req, res)) return;
  if (handleSupabase(pathname, req, res)) return;
  serveStatic(PLAYER_DIR, pathname, res, false);
});

// ─── Signal Predictor server  (port 3001) ─────────────────────────────────────
function signalDashboardHTML() {
  fillQueue();
  const upcoming = crashQueue.map((e, i) => ({ pos: i + 1, multiplier: e.multiplier }));
  const current = { roundId: game.roundId, status: game.status, crashPoint: game.crashPoint, multiplier: game.multiplier };

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>JETPESA Signal</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0a0a0f; color:#fff; font-family:'Segoe UI',system-ui,sans-serif; min-height:100vh; }
  .header { background:linear-gradient(135deg,#0f1923,#1a1a2e); padding:20px 30px; border-bottom:1px solid rgba(255,255,255,0.05); display:flex; align-items:center; justify-content:space-between; }
  .header h1 { font-size:24px; background:linear-gradient(135deg,#00ff88,#00d4ff); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .header .badge { background:rgba(0,255,136,0.1); border:1px solid rgba(0,255,136,0.3); padding:6px 14px; border-radius:20px; font-size:12px; color:#00ff88; }
  .container { max-width:900px; margin:0 auto; padding:24px; }
  .live-card { background:linear-gradient(135deg,#111827,#1f2937); border:1px solid rgba(255,255,255,0.08); border-radius:20px; padding:30px; margin-bottom:24px; text-align:center; position:relative; overflow:hidden; }
  .live-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,#00ff88,#00d4ff,#8b5cf6); }
  .live-label { font-size:12px; text-transform:uppercase; letter-spacing:3px; color:#888; margin-bottom:8px; }
  .live-status { font-size:14px; color:#aaa; margin-bottom:4px; }
  .live-status .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; animation:pulse 1.5s infinite; }
  .live-status .dot.waiting { background:#eab308; }
  .live-status .dot.flying { background:#22c55e; }
  .live-status .dot.crashed { background:#ef4444; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .live-value { font-size:56px; font-weight:800; font-family:'Courier New',monospace; margin:12px 0; }
  .live-value.waiting { color:#eab308; }
  .live-value.flying { color:#22c55e; }
  .live-value.crashed { color:#ef4444; }
  .round-id { font-size:11px; color:#555; font-family:monospace; }
  .section-title { font-size:18px; font-weight:700; margin-bottom:16px; display:flex; align-items:center; gap:10px; }
  .section-title .icon { font-size:22px; }
  .queue-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
  .queue-card { background:linear-gradient(135deg,#111827,#1a1a2e); border:1px solid rgba(255,255,255,0.06); border-radius:14px; padding:18px; text-align:center; transition:all 0.3s; position:relative; overflow:hidden; }
  .queue-card:hover { transform:translateY(-2px); border-color:rgba(0,255,136,0.2); box-shadow:0 8px 30px rgba(0,255,136,0.05); }
  .queue-card.next { border-color:rgba(0,255,136,0.4); background:linear-gradient(135deg,#0a2a1a,#1a1a2e); }
  .queue-card.next::before { content:'NEXT'; position:absolute; top:8px; right:8px; font-size:9px; background:rgba(0,255,136,0.2); color:#00ff88; padding:2px 8px; border-radius:8px; letter-spacing:1px; font-weight:700; }
  .queue-pos { font-size:11px; color:#555; font-weight:600; margin-bottom:6px; }
  .queue-val { font-size:28px; font-weight:800; font-family:'Courier New',monospace; }
  .queue-val.low { color:#ef4444; }
  .queue-val.mid { color:#eab308; }
  .queue-val.high { color:#22c55e; }
  .queue-val.moon { color:#8b5cf6; }
  .queue-label { font-size:10px; margin-top:6px; padding:2px 10px; border-radius:10px; display:inline-block; font-weight:600; }
  .queue-label.low { background:rgba(239,68,68,0.15); color:#ef4444; }
  .queue-label.mid { background:rgba(234,179,8,0.15); color:#eab308; }
  .queue-label.high { background:rgba(34,197,94,0.15); color:#22c55e; }
  .queue-label.moon { background:rgba(139,92,246,0.15); color:#8b5cf6; }
  .refresh-bar { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
  .refresh-bar .timer { font-size:12px; color:#555; }
  .footer { text-align:center; padding:30px; color:#333; font-size:11px; }
</style></head><body>
<div class="header">
  <h1>🔮 JETPESA Signal</h1>
  <div class="badge">🟢 Live • Auto-refresh 3s</div>
</div>
<div class="container">
  <div class="live-card">
    <div class="live-label">Current Round</div>
    <div class="live-status"><span class="dot ${current.status}"></span>${current.status.toUpperCase()}</div>
    <div class="live-value ${current.status}">${current.status === 'crashed' ? current.crashPoint + 'x' : current.status === 'flying' ? current.multiplier.toFixed(2) + 'x' : '⏳'}</div>
    <div class="live-label" style="margin-top:4px;">Crash Target</div>
    <div style="font-size:32px;font-weight:800;color:#00d4ff;font-family:monospace;margin-top:4px;">${current.crashPoint}x</div>
    <div class="round-id">${current.roundId}</div>
  </div>

  <div class="refresh-bar">
    <div class="section-title"><span class="icon">📡</span> Upcoming Crash Points</div>
    <div class="timer" id="timer">Refreshing...</div>
  </div>
  <div class="queue-grid">
    ${upcoming.map((q, i) => {
      const tier = q.multiplier < 10 ? 'low' : q.multiplier < 60 ? 'mid' : q.multiplier < 150 ? 'high' : 'moon';
      const tierLabel = q.multiplier < 10 ? 'RISKY' : q.multiplier < 60 ? 'SAFE' : q.multiplier < 150 ? 'GREAT' : '🚀 MOON';
      return `<div class="queue-card${i === 0 ? ' next' : ''}">
        <div class="queue-pos">Round #${q.pos}</div>
        <div class="queue-val ${tier}">${q.multiplier}x</div>
        <div class="queue-label ${tier}">${tierLabel}</div>
      </div>`;
    }).join('')}
  </div>
</div>
<div class="footer">JETPESA Signal System • For authorized use only</div>
<script>
  let countdown = 3;
  const timerEl = document.getElementById('timer');
  setInterval(() => {
    countdown--;
    if (countdown <= 0) { location.reload(); return; }
    timerEl.textContent = 'Refresh in ' + countdown + 's';
  }, 1000);
</script>
</body></html>`;
}

const signalServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { pathname } = new URL(req.url, `http://localhost:${SIGNAL_PORT}`);

  if (pathname === '/api/data') {
    fillQueue();
    const current = { roundId: game.roundId, status: game.status, crashPoint: game.crashPoint, multiplier: game.multiplier };
    const upcoming = crashQueue.map((e, i) => ({ position: i + 1, multiplier: e.multiplier }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ current, upcoming }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(signalDashboardHTML());
});

// ─── Admin server  (port 3002) ────────────────────────────────────────────────
const adminServer = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${ADMIN_PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, Prefer, x-client-info');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (handleAPI(pathname, req, res)) return;
  if (handleSupabase(pathname, req, res)) return;
  serveStatic(ADMIN_DIR, pathname, res, true);
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (MODE === 'player' || MODE === 'both') {
  playerServer.listen(PLAYER_PORT, () => {
    console.log(`🎮 Player App  → http://localhost:${PLAYER_PORT}`);
    console.log(`🔮 Signal      → http://localhost:${PLAYER_PORT}/signal`);
  });
}

// Separate signal server only in local dev (Railway doesn't support multiple ports)
if (!IS_RAILWAY) {
  signalServer.listen(SIGNAL_PORT, () => {
    console.log(`🔮 Signal Tool → http://localhost:${SIGNAL_PORT}`);
  });
}

if (MODE === 'admin' || MODE === 'both') {
  adminServer.listen(ADMIN_PORT, () => {
    console.log(`🛠️  Admin Panel → http://localhost:${ADMIN_PORT}`);
  });
}
