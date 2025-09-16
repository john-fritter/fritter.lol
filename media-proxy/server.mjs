// server.mjs — media-proxy (public-friendly endpoints)

import express from 'express';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 8080;

// Create a router to handle /api/media paths
const apiRouter = express.Router();
app.use('/api/media', apiRouter);

// Enable detailed logging for debugging
app.use((req, res, next) => {
  console.log(`===== DEBUG =====`);
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  console.log(`Original URL: ${req.originalUrl}`);
  console.log(`Base URL: ${req.baseUrl}`);
  console.log(`Host: ${req.headers.host}`);
  console.log(`Referer: ${req.headers.referer || 'none'}`);
  console.log(`================`);
  next();
});

const TAUTULLI_URL = process.env.TAUTULLI_URL;       // e.g. http://tautulli:8181
const TAUTULLI_KEY = process.env.TAUTULLI_KEY;       // from Tautulli UI
const OVERSEERR_URL = process.env.OVERSEERR_URL;     // optional here
const OVERSEERR_KEY = process.env.OVERSEERR_KEY;
const PLEX_URL = process.env.PLEX_URL;               // e.g. http://plex:32400
const PLEX_TOKEN = process.env.PLEX_TOKEN;           // Plex authentication token

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 1500);
const hasTautulliEnv = !!(TAUTULLI_URL && TAUTULLI_KEY);
const hasPlexEnv = !!(PLEX_URL && PLEX_TOKEN);

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

// Build a poster via Plex directly (never expose upstream tokens to the browser)
function posterFromTautulli(raw) {
  if (!hasPlexEnv) return null;
  
  // absolute url?
  if (raw?.thumb_url?.startsWith('http')) {
    console.log(`Building poster URL from thumb_url: ${raw.thumb_url}`);
    return `/api/media/img?u=${encodeURIComponent(raw.thumb_url)}`;
  }
  
  // PMS thumb path - connect directly to Plex with authentication
  if (raw?.thumb?.startsWith('/')) {
    const plexUrl = `${PLEX_URL}${raw.thumb}?width=300&height=450&X-Plex-Token=${PLEX_TOKEN}`;
    console.log(`Building poster URL from thumb: ${raw.thumb} -> ${PLEX_URL}${raw.thumb}?width=300&height=450&X-Plex-Token=[REDACTED]`);
    return `/api/media/img?u=${encodeURIComponent(plexUrl)}`;
  }
  
  console.log(`No valid poster source found in:`, raw);
  return null;
}

// --- diagnostics ---
// Add a root health check endpoint outside the /api/media path
app.get('/health', (req, res) => res.json({ ok: true }));

// Add the health check on the /api/media path too
apiRouter.get('/health', (req, res) => res.json({
  ok: true, hasTautulli: hasTautulliEnv, timeoutMs: TIMEOUT_MS
}));

apiRouter.get('/img', async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).json({ error: 'missing u' });
    
    console.log(`Image proxy request for: ${u}`);
    
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    
    const r = await fetch(u, { 
      signal: ac.signal,
      headers: {
        'User-Agent': 'media-proxy/1.0'
      }
    });
    
    clearTimeout(t);
    
    if (!r.ok) {
      console.error(`Image proxy error: ${r.status} ${r.statusText} for URL: ${u}`);
      // Return a placeholder instead of error JSON for images
      return res.redirect('/placeholder-poster.jpg');
    }
    
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600'); // Cache images for 1 hour
    
    r.body.pipe(res);
  } catch (e) {
    console.error(`Image proxy exception: ${e.message}`);
    // Return placeholder instead of JSON error for images
    res.redirect('/placeholder-poster.jpg');
  }
});

// --- Recently watched (most recent plays across users) ---
apiRouter.get('/recently-watched', async (req, res) => {
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
apiRouter.get('/activity/daily', async (req, res) => {
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

// --- Recently added (most recent additions across libraries) ---
apiRouter.get('/recently-added', async (req, res) => {
  if (!hasTautulliEnv) return res.json({ items: [], warning: 'tautulli not configured' });

  const limit = Number(req.query.limit || 10);
  const key = `added-${limit}`;
  const hit = getC(key); if (hit) return res.json(hit);

  // Tautulli recently_added: most installs support cmd=get_recently_added with a list in response.data
  const r = await safeFetchJson(`${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_recently_added&count=${Math.max(30, limit*2)}`);
  if (!r.ok) return res.json({ items: [], warning: `tautulli: ${r.error}` });

  // The data is nested under recently_added, not directly in data
  const list = arr(r.json?.response?.data?.recently_added); // tolerate array/object shapes
  console.log(`Recently added raw data count: ${list.length}`);
  if (list.length > 0) {
    console.log('First recently added item:', JSON.stringify(list[0], null, 2));
  }
  
  // Map to minimal fields
  const items = [];
  for (const x of list) {
    // Based on the actual Tautulli data structure:
    // For seasons: use parent_title (show name) + title (season)
    // For movies: use title directly
    let displayTitle;
    if (x.media_type === 'season' && x.parent_title) {
      displayTitle = `${x.parent_title} — ${x.title}`;
    } else if (x.media_type === 'movie') {
      displayTitle = x.title || x.original_title || 'Unknown Movie';
    } else {
      displayTitle = x.title || x.parent_title || x.full_title || 'Unknown';
    }
    
    const gp = x.parent_title || x.grandparent_title || null;
    
    // Convert epoch timestamp to milliseconds
    let added = x.added_at;
    if (typeof added === 'string') {
      added = parseInt(added) * 1000; // Convert from seconds to milliseconds
    } else if (typeof added === 'number' && added < 9999999999) {
      added = added * 1000; // Convert from seconds to milliseconds
    }
    if (!added) added = Date.now();
    
    // Use the thumb field for poster
    const poster = posterFromTautulli({ thumb: x.thumb }) || posterFromTautulli({ thumb: x.parent_thumb }) || null;
    
    console.log(`Recently added item: ${displayTitle} (${x.media_type || 'unknown type'}) - poster: ${poster ? 'yes' : 'no'}`);
    
    items.push({
      title: displayTitle,
      grandparent_title: gp,
      year: x.year || null,
      added_at: added,
      media_type: x.media_type || '',
      poster
    });
    if (items.length >= limit) break;
  }

  // Sort newest first if timestamps exist
  items.sort((a,b) => (b.added_at||0) - (a.added_at||0));

  const payload = { items };
  setC(key, payload, 30000);
  res.json(payload);
});

// --- Weekly Activity (7x8 grid of time blocks) ---
apiRouter.get('/activity/weekly', async (req, res) => {
  if (!hasTautulliEnv) return res.json({ data: {}, warning: 'tautulli not configured' });

  const key = 'activity-weekly';
  const hit = getC(key); if (hit) return res.json(hit);

  // Helper function to create empty weekly data grid
  function createEmptyWeeklyData() {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
    const emptyData = {};
    
    for (const day of days) {
      for (const block of timeBlocks) {
        emptyData[`${day}_${block}`] = 0;
      }
    }
    return emptyData;
  }

  let r;
  try {
    r = await safeFetchJson(`${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_history&length=500`);
    if (!r.ok) return res.json({ data: createEmptyWeeklyData(), warning: `tautulli: ${r.error}` });
  } catch (err) {
    console.error('Error fetching weekly data:', err);
    return res.json({ data: createEmptyWeeklyData(), warning: `tautulli connection error` });
  }

  const list = arr(r.json?.response?.data);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
  const weekData = {};
  
  // Initialize all time blocks with zero
  for (const day of days) {
    for (const block of timeBlocks) {
      weekData[`${day}_${block}`] = 0;
    }
  }
  
  // Calculate a week ago from now
  const now = Date.now();
  const weekAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  for (const x of list) {
    const t = getWatchedAt(x);
    if (!t || t < weekAgo) continue;
    
    const date = new Date(t);
    const day = days[date.getDay() === 0 ? 6 : date.getDay() - 1]; // Convert to Mon-Sun
    const hour = date.getHours();
    const blockIndex = Math.floor(hour / 3);
    const block = timeBlocks[blockIndex];
    
    const key = `${day}_${block}`;
    weekData[key] = (weekData[key] || 0) + 1;
  }

  const payload = { data: weekData };
  setC(key, payload, 30000);
  res.json(payload);
});

// --- Monthly Activity (GitHub-style calendar) ---
apiRouter.get('/activity/monthly', async (req, res) => {
  if (!hasTautulliEnv) return res.json({ data: {}, warning: 'tautulli not configured' });

  const key = 'activity-monthly';
  const hit = getC(key); if (hit) return res.json(hit);

  // Helper function to create empty monthly data
  function createEmptyMonthlyData() {
    const emptyData = {};
    for (let i = 0; i < 30; i++) {
      emptyData[`day_${i+1}`] = 0;
    }
    return emptyData;
  }

  let r;
  try {
    r = await safeFetchJson(`${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_history&length=800`);
    if (!r.ok) return res.json({ data: createEmptyMonthlyData(), warning: `tautulli: ${r.error}` });
  } catch (err) {
    console.error('Error fetching monthly data:', err);
    return res.json({ data: createEmptyMonthlyData(), warning: `tautulli connection error` });
  }

  const list = arr(r.json?.response?.data);
  const monthData = {};
  
  // Initialize last 30 days with zero
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    monthData[`day_${i+1}`] = 0;
  }
  
  const monthAgo = now - (30 * 24 * 60 * 60 * 1000);
  
  for (const x of list) {
    const t = getWatchedAt(x);
    if (!t || t < monthAgo) continue;
    
    const daysAgo = Math.floor((now - t) / (24 * 60 * 60 * 1000));
    if (daysAgo < 30) {
      const dayKey = `day_${30 - daysAgo}`;
      monthData[dayKey] = (monthData[dayKey] || 0) + 1;
    }
  }

  const payload = { data: monthData };
  setC(key, payload, 30000);
  res.json(payload);
});

// Debug routes to help diagnose issues
app.get('/', (req, res) => {
  res.json({ message: 'API server running. Use /api/media/* routes to access endpoints.' });
});

// Debug endpoint to see raw Tautulli data
apiRouter.get('/debug/tautulli-recently-added', async (req, res) => {
  if (!hasTautulliEnv) return res.json({ error: 'tautulli not configured' });
  
  try {
    const r = await safeFetchJson(`${TAUTULLI_URL}/api/v2?apikey=${TAUTULLI_KEY}&cmd=get_recently_added&count=5`);
    if (!r.ok) return res.json({ error: `tautulli: ${r.error}` });
    
    return res.json({
      success: true,
      raw_response: r.json,
      processed_list: arr(r.json?.response?.data)
    });
  } catch (err) {
    return res.json({ error: err.message });
  }
});

app.get('/debug-routes', (req, res) => {
  // Create a list of all registered routes
  const routes = [];
  
  // For the main app routes
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      // Routes registered directly on the app
      routes.push({ 
        path: middleware.route.path, 
        methods: Object.keys(middleware.route.methods).join(',') 
      });
    } else if (middleware.name === 'router') {
      // Router middleware
      middleware.handle.stack.forEach(handler => {
        if (handler.route) {
          const path = handler.route.path;
          routes.push({ 
            path: `/api/media${path}`, 
            methods: Object.keys(handler.route.methods).join(',')
          });
        }
      });
    }
  });
  
  res.json({ routes });
});

// (keep old endpoints if you want; otherwise we're done)

// Print all registered routes on startup
console.log('\n===== REGISTERED ROUTES =====');
const printRoutes = (stack, basePath = '') => {
  stack.forEach(layer => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase() || 'ANY';
      console.log(`${methods} ${basePath}${layer.route.path}`);
    } else if (layer.name === 'router' && layer.handle.stack) {
      // This is our router, so we need to ensure '/api/media' is added to paths
      const routerPath = '/api/media';
      printRoutes(layer.handle.stack, routerPath);
    }
  });
};

printRoutes(app._router.stack);
console.log('===========================\n');

app.listen(port, () => {
  console.log(`\n🚀 media-proxy listening on port ${port}`);
  console.log(`Try accessing: http://localhost:${port}/`);
  console.log(`API paths: http://localhost:${port}/api/media/health`);
  console.log(`Debug: http://localhost:${port}/debug-routes`);
});
