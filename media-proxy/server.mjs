// server.mjs — media-proxy (public-friendly endpoints)

import express from 'express';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';

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

// Jellyfin configuration
const JELLYFIN_URL = process.env.JELLYFIN_URL;       // e.g. http://jellyfin:8096
const JELLYFIN_TOKEN = process.env.JELLYFIN_TOKEN;   // Jellyfin API token
const JELLYFIN_USER_ID = process.env.JELLYFIN_USER_ID; // Jellyfin user ID
const JELLYFIN_DB_PATH = process.env.JELLYFIN_DB_PATH; // Path to jellyfin.db file

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 1500);
const hasJellyfinEnv = !!(JELLYFIN_URL && JELLYFIN_TOKEN && JELLYFIN_USER_ID);

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


// Build a poster via Jellyfin directly (never expose upstream tokens to the browser)
function posterFromJellyfin(item) {
  if (!hasJellyfinEnv) return null;
  
  // Jellyfin image API: /Items/{ItemId}/Images/{ImageType}
  const imageId = item.ImageTags?.Primary || item.ImageTags?.Thumb;
  if (imageId && item.Id) {
    const jellyfinUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Primary?height=450&width=300&quality=96&tag=${imageId}`;
    console.log(`Building Jellyfin poster URL for item ${item.Id}: ${item.Name}`);
    return `/api/media/img?u=${encodeURIComponent(jellyfinUrl)}&auth=jellyfin`;
  }
  
  console.log(`No valid poster source found for Jellyfin item:`, item.Name || item.Id);
  return null;
}

// Helper to make authenticated Jellyfin API requests
async function jellyfinRequest(endpoint, timeout = TIMEOUT_MS) {
  if (!hasJellyfinEnv) return { ok: false, error: 'jellyfin not configured' };
  
  const url = `${JELLYFIN_URL}${endpoint}`;
  const headers = {
    'Authorization': `MediaBrowser Token="${JELLYFIN_TOKEN}"`,
    'Accept': 'application/json'
  };
  
  return await safeFetchJson(url, { headers }, timeout);
}

// --- SQLite database functions for Playback Reporting plugin ---
function openJellyfinDatabase() {
  if (!JELLYFIN_DB_PATH) {
    throw new Error('JELLYFIN_DB_PATH not configured');
  }
  
  try {
    const db = new Database(JELLYFIN_DB_PATH, { readonly: true });
    return db;
  } catch (error) {
    throw new Error(`Failed to open Jellyfin database: ${error.message}`);
  }
}

function getPlaybackEvents(db, daysBack = 30) {
  try {
    // Try different possible table names and column names that the Playback Reporting plugin might use
    const possibleQueries = [
      // Common Playback Reporting plugin table structure
      `SELECT DateCreated as timestamp FROM PlaybackReporting_PlaybackActivity WHERE DateCreated >= datetime('now', '-${daysBack} days')`,
      `SELECT DatePlayed as timestamp FROM PlaybackReporting_PlaybackActivity WHERE DatePlayed >= datetime('now', '-${daysBack} days')`,
      `SELECT PlaybackReportingId, DateCreated as timestamp FROM PlaybackReporting_PlaybackActivity WHERE DateCreated >= datetime('now', '-${daysBack} days')`,
      // Alternative table names
      `SELECT DateCreated as timestamp FROM PlaybackActivity WHERE DateCreated >= datetime('now', '-${daysBack} days')`,
      `SELECT DatePlayed as timestamp FROM PlaybackActivity WHERE DatePlayed >= datetime('now', '-${daysBack} days')`,
      // Fallback to any table with playback in the name
      `SELECT DateCreated as timestamp FROM sqlite_master WHERE type='table' AND name LIKE '%playback%'`
    ];

    for (const query of possibleQueries) {
      try {
        const stmt = db.prepare(query);
        const rows = stmt.all();
        if (rows && rows.length > 0) {
          console.log(`Successfully queried playback data: ${rows.length} events found`);
          return rows.map(row => ({
            timestamp: new Date(row.timestamp)
          })).filter(event => !isNaN(event.timestamp.getTime()));
        }
      } catch (queryError) {
        // Continue to next query if this one fails
        continue;
      }
    }
    
    // If no queries worked, let's see what tables are available
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Available tables in Jellyfin database:', tables.map(t => t.name));
    
    return [];
  } catch (error) {
    console.error('Error querying playback events:', error.message);
    return [];
  }
}

function buildWeeklyActivityData(events) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
  const data = {};
  
  // Initialize all buckets to 0
  for (const day of days) {
    for (const block of timeBlocks) {
      data[`${day}_${block}`] = 0;
    }
  }
  
  // Count events in each bucket
  for (const event of events) {
    const date = event.timestamp;
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const hour = date.getHours();
    
    // Convert JavaScript day (0=Sunday) to our format (0=Monday)
    const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const dayName = days[dayIndex];
    
    // Determine time block
    const blockIndex = Math.floor(hour / 3);
    const blockName = timeBlocks[blockIndex];
    
    const key = `${dayName}_${blockName}`;
    if (data[key] !== undefined) {
      data[key]++;
    }
  }
  
  return data;
}

function buildMonthlyActivityData(events) {
  const data = {};
  const now = new Date();
  
  // Initialize all days to 0 (day_1 = today, day_30 = 30 days ago)
  for (let i = 1; i <= 30; i++) {
    data[`day_${i}`] = 0;
  }
  
  // Count events for each day
  for (const event of events) {
    const eventDate = event.timestamp;
    const diffTime = now.getTime() - eventDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    // Only count events from the last 30 days
    if (diffDays >= 0 && diffDays < 30) {
      const dayKey = `day_${30 - diffDays}`; // day_30 = 30 days ago, day_1 = today
      if (data[dayKey] !== undefined) {
        data[dayKey]++;
      }
    }
  }
  
  return data;
}

// --- diagnostics ---
// Add a root health check endpoint outside the /api/media path
app.get('/health', (req, res) => res.json({ ok: true }));

// Add the health check on the /api/media path too
apiRouter.get('/health', (req, res) => res.json({
  ok: true, 
  hasJellyfin: hasJellyfinEnv,
  timeoutMs: TIMEOUT_MS
}));

apiRouter.get('/img', async (req, res) => {
  try {
    const u = req.query.u;
    const auth = req.query.auth;
    if (!u) return res.status(400).json({ error: 'missing u' });
    
    console.log(`Image proxy request for: ${u} (auth: ${auth || 'none'})`);
    
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    
    const headers = {
      'User-Agent': 'media-proxy/1.0'
    };
    
    // Add Jellyfin authentication if needed
    if (auth === 'jellyfin') {
      headers['Authorization'] = `MediaBrowser Token="${JELLYFIN_TOKEN}"`;
    }
    
    const r = await fetch(u, { 
      signal: ac.signal,
      headers
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
  if (!hasJellyfinEnv) return res.json({ items: [], warning: 'jellyfin not configured' });

  const limit = Number(req.query.limit || 12);
  const key = `jellyfin-watched-${limit}`;
  const hit = getC(key); if (hit) return res.json(hit);

  // Get recently played items from Jellyfin
  const r = await jellyfinRequest(`/Users/${JELLYFIN_USER_ID}/Items?SortBy=DatePlayed&SortOrder=Descending&Limit=${limit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=Movie,Episode`);
  if (!r.ok) return res.json({ items: [], warning: `jellyfin: ${r.error}` });

  const list = r.json?.Items || [];
  const items = [];
  
  for (const item of list) {
    // Only include items that have been played
    if (!item.UserData?.LastPlayedDate) continue;
    
    let title = item.Name || 'Unknown';
    let grandparent_title = null;
    
    // For TV episodes, show series name and episode title
    if (item.Type === 'Episode') {
      grandparent_title = item.SeriesName;
      if (item.SeasonName && item.IndexNumber) {
        title = `${item.SeasonName} E${item.IndexNumber} - ${item.Name}`;
      }
    }
    
    const watchedAt = item.UserData.LastPlayedDate ? new Date(item.UserData.LastPlayedDate).getTime() : null;
    const poster = posterFromJellyfin(item);
    
    items.push({
      title,
      grandparent_title,
      year: item.ProductionYear || null,
      watched_at: watchedAt,
      media_type: item.Type?.toLowerCase() || '',
      poster
    });
  }

  // Sort newest first if timestamps exist
  items.sort((a,b) => (b.watched_at||0) - (a.watched_at||0));

  const payload = { items };
  setC(key, payload, 15000);
  res.json(payload);
});

// --- Activity endpoints removed (were Tautulli-dependent) ---

// --- Recently added (most recent additions across libraries) ---
apiRouter.get('/recently-added', async (req, res) => {
  if (!hasJellyfinEnv) return res.json({ items: [], warning: 'jellyfin not configured' });

  const limit = Number(req.query.limit || 10);
  const key = `jellyfin-added-${limit}`;
  const hit = getC(key); if (hit) return res.json(hit);

  // Get recently added items from Jellyfin
  const r = await jellyfinRequest(`/Users/${JELLYFIN_USER_ID}/Items/Latest?Limit=${limit}&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
  if (!r.ok) return res.json({ items: [], warning: `jellyfin: ${r.error}` });

  const list = r.json || [];
  const items = [];
  
  for (const item of list) {
    let title = item.Name || 'Unknown';
    let grandparent_title = null;
    
    // For TV episodes/seasons, show series name
    if (item.Type === 'Episode') {
      grandparent_title = item.SeriesName;
      if (item.SeasonName && item.IndexNumber) {
        title = `${item.SeasonName} E${item.IndexNumber} - ${item.Name}`;
      }
    } else if (item.Type === 'Season') {
      grandparent_title = item.SeriesName;
      title = `${item.Name}`;
    }
    
    const addedAt = item.DateCreated ? new Date(item.DateCreated).getTime() : Date.now();
    const poster = posterFromJellyfin(item);
    
    console.log(`Jellyfin recently added item: ${title} (${item.Type || 'unknown type'}) - poster: ${poster ? 'yes' : 'no'}`);
    
    items.push({
      title,
      grandparent_title,
      year: item.ProductionYear || null,
      added_at: addedAt,
      media_type: item.Type?.toLowerCase() || '',
      poster
    });
  }

  // Sort newest first if timestamps exist
  items.sort((a,b) => (b.added_at||0) - (a.added_at||0));

  const payload = { items };
  setC(key, payload, 30000);
  res.json(payload);
});

// Activity endpoints using Jellyfin Playback Reporting plugin data
apiRouter.get('/activity/weekly', async (req, res) => {
  const key = 'jellyfin-activity-weekly';
  const hit = getC(key); 
  if (hit) return res.json(hit);

  // Fallback empty data structure
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
  const emptyData = {};
  
  for (const day of days) {
    for (const block of timeBlocks) {
      emptyData[`${day}_${block}`] = 0;
    }
  }

  try {
    if (!JELLYFIN_DB_PATH) {
      const payload = { data: emptyData, warning: 'JELLYFIN_DB_PATH not configured' };
      setC(key, payload, 30000);
      return res.json(payload);
    }

    const db = openJellyfinDatabase();
    const events = getPlaybackEvents(db, 7); // Last 7 days for weekly view
    db.close();
    
    if (events.length === 0) {
      const payload = { data: emptyData, warning: 'No playback events found in Jellyfin database' };
      setC(key, payload, 30000);
      return res.json(payload);
    }

    const activityData = buildWeeklyActivityData(events);
    const payload = { data: activityData };
    setC(key, payload, 30000); // Cache for 30 seconds
    res.json(payload);
    
  } catch (error) {
    console.error('Error reading Jellyfin playback data for weekly activity:', error.message);
    const payload = { data: emptyData, warning: `Database error: ${error.message}` };
    setC(key, payload, 30000);
    res.json(payload);
  }
});

apiRouter.get('/activity/monthly', async (req, res) => {
  const key = 'jellyfin-activity-monthly';
  const hit = getC(key);
  if (hit) return res.json(hit);

  // Fallback empty data structure
  const emptyData = {};
  for (let i = 1; i <= 30; i++) {
    emptyData[`day_${i}`] = 0;
  }

  try {
    if (!JELLYFIN_DB_PATH) {
      const payload = { data: emptyData, warning: 'JELLYFIN_DB_PATH not configured' };
      setC(key, payload, 30000);
      return res.json(payload);
    }

    const db = openJellyfinDatabase();
    const events = getPlaybackEvents(db, 30); // Last 30 days for monthly view
    db.close();
    
    if (events.length === 0) {
      const payload = { data: emptyData, warning: 'No playback events found in Jellyfin database' };
      setC(key, payload, 30000);
      return res.json(payload);
    }

    const activityData = buildMonthlyActivityData(events);
    const payload = { data: activityData };
    setC(key, payload, 30000); // Cache for 30 seconds
    res.json(payload);
    
  } catch (error) {
    console.error('Error reading Jellyfin playback data for monthly activity:', error.message);
    const payload = { data: emptyData, warning: `Database error: ${error.message}` };
    setC(key, payload, 30000);
    res.json(payload);
  }
});

// Debug routes to help diagnose issues
app.get('/', (req, res) => {
  res.json({ message: 'API server running. Use /api/media/* routes to access endpoints.' });
});

// Debug endpoint for Jellyfin data
apiRouter.get('/debug/jellyfin-info', async (req, res) => {
  if (!hasJellyfinEnv) return res.json({ error: 'jellyfin not configured' });
  
  try {
    const r = await jellyfinRequest(`/System/Info`);
    if (!r.ok) return res.json({ error: `jellyfin: ${r.error}` });
    
    return res.json({
      success: true,
      server_info: {
        version: r.json?.Version,
        name: r.json?.ServerName,
        id: r.json?.Id
      }
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
