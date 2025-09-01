// server.mjs — media-proxy (public-friendly endpoints)

import express from 'express';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 8080;

const TAUTULLI_URL = process.env.TAUTULLI_URL;       // e.g. http://tautulli:8181
const TAUTULLI_KEY = process.env.TAUTULLI_KEY;       // from Tautulli UI
const OVERSEERR_URL = process.env.OVERSEERR_URL;     // optional here
const OVERSEERR_KEY = process.env.OVERSEERR_KEY;

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 1500);
const hasTautulliEnv = !!(TAUTULLI_URL && TAUTULLI_KEY);

// --- tiny cache ---
const cache = new Map();
const ttl = (ms) => ({ t: Date.now() + ms });
const getC = (k) => { const v = cache.get(k); return (v && v.t > Date.now()) ? v.data : null; };
const setC = (k, data, ms = 10000) => cache.set(k, { data, ...ttl(ms) });

// --- helpers ---
async function safeFetchJson(url, opts = {}, timeout = TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    if (!r.ok) return { ok: false, error: `${r.status} ${r.statusText}` };
    const j = await r.json();
    return { ok: true, json: j };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `timeout after ${timeout}ms` : e.message;
    return { ok: false, error: msg };
  } finally { clearTimeout(t); }
}

// Normalize “array-like” values
const arr = (v) => Array.isArray(v) ? v
  : (v && Array.isArray(v.data)) ? v.data
  : (v && typeof v === 'object') ? Object.values(v)
  : [];

// Try to find a watched timestamp on a history item
function getWatchedAt(x) {
  // common Tautulli fields: date, started, time, last_played, viewed_at
  const candidates = [
    x.viewed_at, x.date, x.started, x.time, x.last_played,
    x.played_at, x.event_time
  ];
  for (const c of candidates) {
    if (!c) continue;
    // Epoch (s)
    if (typeof c === 'number' && c > 100000 && c < 9999999999) return c * 1000;
    // Epoch (ms)
    if (typeof c === 'number' && c >= 9999999999) return c;
    // Parsable string
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Build a poster via Tautulli (never expose upstream tokens to the browser)
function posterFromTautulli(raw) {
  if (!hasTautulliEnv) return null;
  // absolute url?
  if (raw?.thumb_url?.startsWith('http')) {
    return `/api/media/img?u=${encodeURIComponent(raw.thumb_url)}`;
  }
  // PMS thumb path?
  if (raw?.thumb?.startsWith('/')) {
    const u = `${TAUTULLI_URL}/pms/image?url=${encodeURIComponent(raw.thumb)}&width=300&height=450&fallback=poster&apikey=${TAUTULLI_KEY}`;
    return `/api/media/img?u=${encodeURIComponent(u)}`;
  }
  return null;
}

// --- diagnostics ---
app.get('/api/media/health', (req, res) => res.json({
  ok: true, hasTautulli: hasTautulliEnv, timeoutMs: TIMEOUT_MS
}));

app.get('/api/media/img', async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).json({ error: 'missing u' });
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const r = await fetch(u, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return res.status(502).json({ error: `upstream ${r.status}` });
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message });
  }
});

// --- Recently watched (most recent plays across users) ---
app.get('/api/media/recently-watched', async (req, res) => {
  if (!hasTautulliEnv) return res.json({ items: [], warning: 'tautulli not configured' });

  const limit = Number(req.query.limit || 12);
  const key = `watched-${limit}`;
  const hit = getC(key); if (hit) return res.json(hit);

  // Tautulli history: most installs support cmd=get_history with a list in response.data
  const r = await safeFetchJson(`${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_history&length=${Math.max(50, limit*3)}`);
  if (!r.ok) return res.json({ items: [], warning: `tautulli: ${r.error}` });

  const list = arr(r.json?.response?.data); // tolerate array/object shapes
  // Map to minimal fields; de-dup consecutive items of same episode/title
  const items = [];
  for (const x of list) {
    const title = x.title || x.full_title || x.media_title || x.grandparent_title || 'Unknown';
    const gp = x.grandparent_title || null;
    const t = getWatchedAt(x);
    const poster = posterFromTautulli(x) || posterFromTautulli({ thumb_url: x.thumb_url, thumb: x.thumb });
    items.push({
      title,
      grandparent_title: gp,
      year: x.year || null,
      watched_at: t,
      media_type: x.media_type || x.section_type || '',
      poster
    });
    if (items.length >= limit) break;
  }

  // Sort newest first if timestamps exist
  items.sort((a,b) => (b.watched_at||0) - (a.watched_at||0));

  const payload = { items };
  setC(key, payload, 15000);
  res.json(payload);
});

// --- Activity counts per day (last N days) ---
app.get('/api/media/activity/daily', async (req, res) => {
  if (!hasTautulliEnv) return res.json({ days: [], counts: [] });

  const days = Number(req.query.days || 7);
  const key = `activity-${days}`;
  const hit = getC(key); if (hit) return res.json(hit);

  const r = await safeFetchJson(`${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_history&length=${Math.max(250, days*40)}`);
  if (!r.ok) return res.json({ days: [], counts: [], warning: `tautulli: ${r.error}` });

  const list = arr(r.json?.response?.data);
  const buckets = new Map(); // key: YYYY-MM-DD -> count
  const today = new Date(); today.setHours(0,0,0,0);

  // seed last N days with zeros
  for (let i=days-1; i>=0; i--) {
    const d = new Date(today.getTime() - i*86400000);
    const k = d.toISOString().slice(0,10);
    buckets.set(k, 0);
  }

  for (const x of list) {
    const t = getWatchedAt(x);
    if (!t) continue;
    const d = new Date(t); d.setHours(0,0,0,0);
    const k = d.toISOString().slice(0,10);
    if (buckets.has(k)) buckets.set(k, buckets.get(k)+1);
  }

  const outDays = Array.from(buckets.keys());
  const counts = Array.from(buckets.values());
  const payload = { days: outDays, counts };
  setC(key, payload, 15000);
  res.json(payload);
});

// (keep old endpoints if you want; otherwise we’re done)

app.listen(port, () => console.log(`media-proxy listening on :${port}`));
