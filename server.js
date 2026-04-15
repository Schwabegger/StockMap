/**
 * StockMap Server
 * ───────────────
 * Run:  node server.js
 * Open: http://localhost:3000
 *
 * Features:
 *  - Patch-based JSON saves (no full rewrites on every change)
 *  - Images stored as files in ./images/items/<id>/ and ./images/locations/<id>/
 *  - Basic auth: one admin (read+write), one guest (read-only)
 *  - No npm dependencies — pure Node stdlib
 *
 * Config: edit .env in the same folder (copy .env.example to .env)
 * For Docker: pass env vars directly — they override .env values
 */

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ── .env loader ───────────────────────────────────────────────────────────────
// Parses KEY=value lines, ignores comments (#) and blank lines.
// Environment variables already set (e.g. from Docker) take priority over .env.
function loadEnv() {
  // Try .env first, then env (without dot) as fallback
  const candidates = [path.join(__dirname, '.env'), path.join(__dirname, 'env')];
  for (const envFile of candidates) {
    try {
      const lines = fs.readFileSync(envFile, 'utf8').split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim()
          .replace(/^["']|["']$/g, ''); // strip optional surrounding quotes
        // Only set if not already defined in the environment (Docker wins)
        if (key && !(key in process.env)) {
          process.env[key] = val;
        }
      }
      break; // stop after first successful file
    } catch {
      // File not found — try next candidate
    }
  }
}

loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT       = Number(process.env.PORT)       || 3000;
const ADMIN_USER = process.env.ADMIN_USER         || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS         || 'stockmap';
const GUEST_USER = process.env.GUEST_USER         || 'guest';
const GUEST_PASS = process.env.GUEST_PASS         || 'readonly';

const DATA_FILE  = path.join(__dirname, 'stock.json');
const TX_FILE    = path.join(__dirname, 'transactions.json');
const HTML_FILE  = path.join(__dirname, 'inventory.html');
const IMG_DIR    = path.join(__dirname, 'images');

// ── Auth ──────────────────────────────────────────────────────────────────────
const USERS = {
  [ADMIN_USER]: { pass: ADMIN_PASS, role: 'admin' },
  [GUEST_USER]: { pass: GUEST_PASS, role: 'guest'  },
};

// In-memory session store: token -> { user, role }
const sessions = new Map();

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function checkBasicAuth(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Basic ')) return null;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  const pass = rest.join(':');
  const record = USERS[user];
  if (!record) return null;
  const valid = crypto.timingSafeEqual(
    Buffer.from(record.pass), Buffer.from(pass.padEnd(record.pass.length))
  ) && pass.length === record.pass.length;
  return valid ? { user, role: record.role } : null;
}

function getSessionFromCookie(req) {
  const cookieHeader = req.headers['cookie'] || '';
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'sm_session') return sessions.get(v.join('=')) || null;
  }
  return null;
}

function requireAuth(req, res) {
  // Accept session cookie (API calls) or Basic Auth (first page load)
  const auth = getSessionFromCookie(req) || checkBasicAuth(req);
  if (!auth) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="StockMap"',
      'Content-Type': 'application/json'
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return null;
  }
  return auth;
}

// ── In-memory state ───────────────────────────────────────────────────────────
let liveState  = null;
let liveTx     = null;   // transactions live separately
let writeQueue = Promise.resolve();
let txWriteQueue = Promise.resolve();

async function ensureLoaded() {
  if (liveState) return;
  try {
    const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
    liveState = JSON.parse(raw);
  } catch {
    liveState = { locations: [], items: [], mapRooms: {} };
  }
  if (!liveState.mapRooms)  liveState.mapRooms  = {};
  if (!liveState.locations) liveState.locations = [];
  if (!liveState.items)     liveState.items     = [];
  // Migrate: if old stock.json has transactions, move them out
  if (liveState.transactions) {
    liveTx = liveState.transactions;
    delete liveState.transactions;
    queueWrite();
    queueTxWrite();
  }
}

async function ensureTxLoaded() {
  if (liveTx) return;
  try {
    const raw = await fs.promises.readFile(TX_FILE, 'utf8');
    liveTx = JSON.parse(raw);
  } catch {
    liveTx = [];
  }
  if (!Array.isArray(liveTx)) liveTx = [];
}

function queueWrite() {
  writeQueue = writeQueue
    .then(() => fs.promises.writeFile(DATA_FILE, JSON.stringify(liveState, null, 2), 'utf8'))
    .catch(err => console.error('[StockMap] Write error:', err));
}

function queueTxWrite() {
  txWriteQueue = txWriteQueue
    .then(() => fs.promises.writeFile(TX_FILE, JSON.stringify(liveTx, null, 2), 'utf8'))
    .catch(err => console.error('[StockMap] TX write error:', err));
}

// ── Patch ─────────────────────────────────────────────────────────────────────
function applyPatch(patch) {
  const s = liveState;
  if (patch.items) {
    const { set=[], delete:del=[] } = patch.items;
    del.forEach(id => { const i=s.items.findIndex(x=>x.id===id); if(i!==-1) s.items.splice(i,1); });
    set.forEach(item => { const i=s.items.findIndex(x=>x.id===item.id); i!==-1 ? s.items[i]=item : s.items.push(item); });
  }
  if (patch.locations) {
    const { set=[], delete:del=[] } = patch.locations;
    del.forEach(id => { const i=s.locations.findIndex(x=>x.id===id); if(i!==-1) s.locations.splice(i,1); });
    set.forEach(loc => { const i=s.locations.findIndex(x=>x.id===loc.id); i!==-1 ? s.locations[i]=loc : s.locations.push(loc); });
  }
  if (patch.mapRooms) {
    const { set={}, delete:del={} } = patch.mapRooms;
    Object.entries(del).forEach(([pk,ids]) => { if(s.mapRooms[pk]) ids.forEach(id=>delete s.mapRooms[pk][id]); });
    Object.entries(set).forEach(([pk,rm]) => { if(!s.mapRooms[pk]) s.mapRooms[pk]={}; Object.assign(s.mapRooms[pk],rm); });
  }
}

function applyTxPatch(patch) {
  const { append=[], update=[], delete:del=[] } = patch;
  del.forEach(id => { const i=liveTx.findIndex(x=>x.id===id); if(i!==-1) liveTx.splice(i,1); });
  append.forEach(tx => liveTx.push(tx));
  update.forEach(tx => { const i=liveTx.findIndex(x=>x.id===tx.id); if(i!==-1) liveTx[i]=tx; });
}

// ── Image helpers ─────────────────────────────────────────────────────────────
const MIME = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif' };

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

// List image filenames for a subject (returns sorted array of filenames)
async function listImages(type, id) {
  const dir = path.join(IMG_DIR, type, id);
  try {
    const files = await fs.promises.readdir(dir);
    return files.filter(f => MIME[path.extname(f).toLowerCase()]).sort();
  } catch { return []; }
}

// Next available filename index
async function nextImageName(type, id, ext) {
  const existing = await listImages(type, id);
  let n = 1;
  while (existing.includes(`${n}${ext}`)) n++;
  return `${n}${ext}`;
}

// ── Body reader ───────────────────────────────────────────────────────────────
function readBodyBuffer(req, maxMB=15) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if(size > maxMB*1024*1024) reject(new Error('Too large')); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBodyJSON(req) {
  const buf = await readBodyBuffer(req, 5);
  return JSON.parse(buf.toString('utf8'));
}

// ── Router ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // CORS (for local dev / direct file access)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    await ensureLoaded();
    const p = url.pathname;

    // ── Serve HTML app (auth required) ──
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const auth = requireAuth(req, res);
      if (!auth) return;
      // Create a session token so JS fetch calls can authenticate without
      // re-sending Basic Auth (browsers don't forward it to fetch())
      const token = makeToken();
      sessions.set(token, { user: auth.user, role: auth.role });
      let html = await fs.promises.readFile(HTML_FILE, 'utf8');
      html = html.replace('/*__AUTH_ROLE__*/',
        `window.__authRole='${auth.role}';window.__authUser='${auth.user}';`);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `sm_session=${token}; Path=/; HttpOnly; SameSite=Strict`
      });
      res.end(html);
      return;
    }

    // All /api/* and /images/* require auth
    if (p.startsWith('/api/') || p.startsWith('/images/')) {
      const auth = requireAuth(req, res);
      if (!auth) return;

      // ── Health check ──
      if (method === 'GET' && p === '/api/ping') {
        json(200, { ok:true, role: auth.role, user: auth.user });
        return;
      }

      // ── Full state (read) ──
      if (method === 'GET' && p === '/api/state') {
        json(200, liveState);
        return;
      }

      // ── Patch (write, admin only) ──
      if (method === 'POST' && p === '/api/patch') {
        if (auth.role !== 'admin') { json(403, {error:'Read-only account'}); return; }
        const patch = await readBodyJSON(req);
        applyPatch(patch);
        queueWrite();
        json(200, { ok:true });
        return;
      }

      // ── Full replace (write, admin only) ──
      if (method === 'POST' && p === '/api/state') {
        if (auth.role !== 'admin') { json(403, {error:'Read-only account'}); return; }
        const data = await readBodyJSON(req);
        if (!data.locations||!data.items||!data.mapRooms) { json(400,{error:'Invalid'}); return; }
        delete data.transactions; // transactions are never part of state
        liveState = data;
        queueWrite();
        json(200, { ok:true });
        return;
      }

      // ── Transactions (read) ──
      if (method === 'GET' && p === '/api/transactions') {
        await ensureTxLoaded();
        json(200, liveTx);
        return;
      }

      // ── Transaction patch (write, admin only) ──
      // Body: { append?: [...], update?: [...], delete?: [...] }
      if (method === 'POST' && p === '/api/transactions') {
        if (auth.role !== 'admin') { json(403, {error:'Read-only account'}); return; }
        await ensureTxLoaded();
        const patch = await readBodyJSON(req);
        applyTxPatch(patch);
        queueTxWrite();
        json(200, { ok:true });
        return;
      }

      // ── Upload image  POST /api/images/:type/:id  ──
      // type = 'items' or 'locations', id = entity id
      const uploadMatch = p.match(/^\/api\/images\/(items|locations)\/([^/]+)$/);
      if (method === 'POST' && uploadMatch) {
        if (auth.role !== 'admin') { json(403, {error:'Read-only account'}); return; }
        const [, type, id] = uploadMatch;
        const ct = req.headers['content-type'] || '';
        const extMap = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/gif':'.gif' };
        const ext = extMap[ct.split(';')[0].trim()] || '.jpg';
        const dir = path.join(IMG_DIR, type, id);
        await ensureDir(dir);
        const fname = await nextImageName(type, id, ext);
        const buf = await readBodyBuffer(req, 15);
        await fs.promises.writeFile(path.join(dir, fname), buf);
        // Return the URL path the client can use
        json(200, { ok:true, url: `/images/${type}/${id}/${fname}` });
        return;
      }

      // ── List images  GET /api/images/:type/:id ──
      const listMatch = p.match(/^\/api\/images\/(items|locations)\/([^/]+)$/);
      if (method === 'GET' && listMatch) {
        const [, type, id] = listMatch;
        const files = await listImages(type, id);
        json(200, { urls: files.map(f => `/images/${type}/${id}/${f}`) });
        return;
      }

      // ── Delete image  DELETE /api/images/:type/:id/:filename ──
      const delMatch = p.match(/^\/api\/images\/(items|locations)\/([^/]+)\/([^/]+)$/);
      if (method === 'DELETE' && delMatch) {
        if (auth.role !== 'admin') { json(403, {error:'Read-only account'}); return; }
        const [, type, id, fname] = delMatch;
        // Safety: only allow known extensions, no path traversal
        if (!MIME[path.extname(fname).toLowerCase()] || fname.includes('/') || fname.includes('..')) {
          json(400, {error:'Invalid filename'}); return;
        }
        const fpath = path.join(IMG_DIR, type, id, fname);
        await fs.promises.unlink(fpath).catch(()=>{});
        json(200, { ok:true });
        return;
      }

      // ── Serve image files  GET /images/:type/:id/:filename ──
      const imgMatch = p.match(/^\/images\/(items|locations)\/([^/]+)\/([^/]+)$/);
      if (method === 'GET' && imgMatch) {
        const [, type, id, fname] = imgMatch;
        if (!MIME[path.extname(fname).toLowerCase()] || fname.includes('..')) {
          res.writeHead(400); res.end(); return;
        }
        const fpath = path.join(IMG_DIR, type, id, fname);
        try {
          const data = await fs.promises.readFile(fpath);
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(fname).toLowerCase()],
            'Cache-Control': 'public, max-age=31536000'  // images are immutable
          });
          res.end(data);
        } catch { res.writeHead(404); res.end(); }
        return;
      }
    }

    res.writeHead(404); res.end('Not found');

  } catch (err) {
    console.error('[StockMap] Error:', err);
    res.writeHead(500, {'Content-Type':'application/json'});
    res.end(JSON.stringify({error: String(err)}));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i?.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║          StockMap Server                     ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:    http://localhost:${PORT}              ║`);
  ips.forEach(ip => {
    const line = `http://${ip}:${PORT}`;
    console.log(`║  Network:  ${line.padEnd(35)}║`);
  });
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Admin:    ${ADMIN_USER} / ${ADMIN_PASS.replace(/./g,'*')}${''.padEnd(Math.max(0,20-ADMIN_USER.length-ADMIN_PASS.length))}  ║`);
  console.log(`║  Guest:    ${GUEST_USER} / ${GUEST_PASS.replace(/./g,'*')}${''.padEnd(Math.max(0,20-GUEST_USER.length-GUEST_PASS.length))}  ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Data:     stock.json / transactions.json    ║`);
  console.log(`║  Images:   images/                           ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log('Change credentials with env vars: ADMIN_USER ADMIN_PASS GUEST_USER GUEST_PASS\n');
  console.log('Ctrl+C to stop.\n');
});
