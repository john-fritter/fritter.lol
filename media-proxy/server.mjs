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
  
  let jellyfinUrl = null;
  
  // Check for Primary image first
  if (item.ImageTags?.Primary) {
    const imageId = item.ImageTags.Primary;
    jellyfinUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Primary?height=450&quality=96&tag=${imageId}`;
    console.log(`Building Jellyfin Primary poster URL for item ${item.Id}: ${item.Name}`);
  }
  // Fall back to Thumb image
  else if (item.ImageTags?.Thumb) {
    const imageId = item.ImageTags.Thumb;
    jellyfinUrl = `${JELLYFIN_URL}/Items/${item.Id}/Images/Thumb?height=300&quality=96&tag=${imageId}`;
    console.log(`Building Jellyfin Thumb poster URL for item ${item.Id}: ${item.Name}`);
  }
  // For Episodes with no Primary, try to get the series poster
  else if (item.Type === 'Episode' && item.SeriesId) {
    jellyfinUrl = `${JELLYFIN_URL}/Items/${item.SeriesId}/Images/Primary?height=450&quality=96`;
    console.log(`Building Jellyfin series poster URL for episode ${item.Id}: ${item.Name} (series: ${item.SeriesId})`);
  }
  
  if (jellyfinUrl) {
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

async function getRecentWatchedAllUsers(limit = 12) {
  const usersResp = await jellyfinRequest('/Users');
  if (!usersResp.ok || !Array.isArray(usersResp.json) || usersResp.json.length === 0) {
    return { ok: false, error: usersResp.error || 'Unable to read Jellyfin users' };
  }

  const users = usersResp.json.filter((u) => u && u.Id && !u.Policy?.IsDisabled);
  if (!users.length) return { ok: false, error: 'No enabled Jellyfin users found' };

  const perUserLimit = Math.max(limit * 2, 20);
  const perUserResults = await Promise.all(users.map(async (user) => {
    const r = await jellyfinRequest(`/Users/${user.Id}/Items?SortBy=DatePlayed&SortOrder=Descending&Limit=${perUserLimit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=Movie,Episode`);
    if (!r.ok) return [];
    const items = Array.isArray(r.json?.Items) ? r.json.Items : [];

    return items
      .filter((item) => item.UserData?.LastPlayedDate)
      .map((item) => {
        let title = item.Name || 'Unknown';
        let grandparent_title = null;

        if (item.Type === 'Episode') {
          grandparent_title = item.SeriesName || null;
          if (item.SeasonName && item.IndexNumber) {
            title = `${item.SeasonName} E${item.IndexNumber} - ${item.Name}`;
          }
        }

        return {
          id: item.Id || null,
          user_id: user.Id,
          title,
          grandparent_title,
          year: item.ProductionYear || null,
          watched_at: new Date(item.UserData.LastPlayedDate).getTime(),
          media_type: item.Type?.toLowerCase() || '',
          poster: posterFromJellyfin(item)
        };
      });
  }));

  const merged = perUserResults.flat().filter((item) => Number.isFinite(item.watched_at));
  if (!merged.length) return { ok: false, error: 'No recently watched items from Jellyfin users' };

  const deduped = [];
  const seen = new Set();
  for (const item of merged.sort((a, b) => b.watched_at - a.watched_at)) {
    const key = `${item.id || item.title}:${item.user_id}:${item.watched_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }

  return { ok: true, items: deduped };
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

function normalizeTimestamp(value) {
  if (!value) return null;
  const coerceNumericTimestamp = (numValue) => {
    if (!Number.isFinite(numValue) || numValue <= 0) return null;
    // .NET ticks (100ns since 0001-01-01)
    if (numValue > 1000000000000000) {
      const ms = Math.floor((numValue - 621355968000000000) / 10000);
      return ms > 0 ? new Date(ms) : null;
    }
    // Unix ms
    if (numValue > 1000000000000) return new Date(numValue);
    // Unix s
    if (numValue > 1000000000) return new Date(numValue * 1000);
    return null;
  };

  if (typeof value === 'number') {
    const d = coerceNumericTimestamp(value);
    return d && Number.isFinite(d.getTime()) ? d : null;
  }

  if (typeof value === 'string') {
    const maybeNum = Number(value);
    if (Number.isFinite(maybeNum)) {
      const d = coerceNumericTimestamp(maybeNum);
      if (d && Number.isFinite(d.getTime())) return d;
    }
  }

  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function getRecentPlaybackRows(db, limit = 12) {
  const fetchLimit = Math.max(limit * 6, 30);
  const tableCandidates = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%Playback%Activity%' OR name LIKE '%playback%activity%') ORDER BY name"
  ).all().map((r) => r.name);
  const fallbackTableCandidates = ['PlaybackReporting_PlaybackActivity', 'PlaybackActivity'];
  const tableNames = [...new Set([...tableCandidates, ...fallbackTableCandidates])];

  for (const tableName of tableNames) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
      if (!cols.length) continue;

      const playedCol = ['DateCreated', 'DatePlayed', 'PlaybackStartDate', 'StartDate', 'Timestamp', 'EventTime']
        .find((c) => cols.includes(c));
      if (!playedCol) continue;

      const itemIdCol = ['ItemId', 'ItemID', 'InternalItemId', 'ItemGuid', 'Guid']
        .find((c) => cols.includes(c));
      const itemNameCol = ['ItemName', 'Name', 'Title']
        .find((c) => cols.includes(c));

      const selectItemId = itemIdCol ? `${itemIdCol} as item_id` : `NULL as item_id`;
      const selectItemName = itemNameCol ? `${itemNameCol} as item_name` : `NULL as item_name`;
      const query = `SELECT ${selectItemId}, ${selectItemName}, ${playedCol} as played_at
        FROM ${tableName}
        WHERE ${playedCol} IS NOT NULL
        ORDER BY ${playedCol} DESC
        LIMIT ${fetchLimit}`;

      const rows = db.prepare(query).all();
      if (!rows || !rows.length) continue;

      const normalized = rows.map((row) => {
        const playedAt = normalizeTimestamp(row.played_at);
        if (!playedAt) return null;
        return {
          item_id: row.item_id ? String(row.item_id) : null,
          item_name: row.item_name ? String(row.item_name) : null,
          played_at: playedAt
        };
      }).filter(Boolean);

      if (normalized.length) return normalized.slice(0, fetchLimit);
    } catch {
      // continue trying next table
    }
  }

  return [];
}

async function getRecentWatchedFromPlaybackDb(limit = 12) {
  if (!JELLYFIN_DB_PATH) {
    return { ok: false, error: 'JELLYFIN_DB_PATH not configured' };
  }

  let db;
  try {
    db = openJellyfinDatabase();
    const rows = getRecentPlaybackRows(db, limit);
    if (!rows.length) {
      return { ok: false, error: 'No playback rows found in reporting DB' };
    }

    const recentRows = rows.slice(0, limit * 3);
    const itemIds = [...new Set(recentRows.map((r) => r.item_id).filter(Boolean))].slice(0, limit * 3);
    const detailsMap = new Map();

    await Promise.all(itemIds.map(async (itemId) => {
      const encoded = encodeURIComponent(itemId);
      const globalItem = await jellyfinRequest(`/Items/${encoded}?Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
      if (globalItem.ok && globalItem.json?.Id) return detailsMap.set(itemId, globalItem.json);
      const scopedItem = await jellyfinRequest(`/Users/${JELLYFIN_USER_ID}/Items/${encoded}?Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
      if (scopedItem.ok && scopedItem.json?.Id) detailsMap.set(itemId, scopedItem.json);
    }));

    const items = [];
    for (const row of recentRows) {
      if (items.length >= limit) break;
      const detail = row.item_id ? detailsMap.get(row.item_id) : null;
      const source = detail || {};

      let title = source.Name || row.item_name || 'Unknown';
      let grandparent_title = null;

      if (source.Type === 'Episode') {
        grandparent_title = source.SeriesName || null;
        if (source.SeasonName && source.IndexNumber) {
          title = `${source.SeasonName} E${source.IndexNumber} - ${source.Name || title}`;
        }
      }

      items.push({
        title,
        grandparent_title,
        year: source.ProductionYear || null,
        watched_at: row.played_at.getTime(),
        media_type: source.Type?.toLowerCase() || '',
        poster: detail ? posterFromJellyfin(source) : null
      });
    }

    items.sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0));
    return { ok: true, items };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
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
  const key = `jellyfin-watched-v2-${limit}`;
  const hit = getC(key); if (hit) return res.json(hit);

  // Source A: aggregate recently played items across all users.
  const allUsersResult = await getRecentWatchedAllUsers(limit);

  // Source B: playback-reporting DB (captures events some clients may not reflect in LastPlayedDate order).
  const dbResult = await getRecentWatchedFromPlaybackDb(limit);

  // Merge A + B for better client coverage.
  const merged = [];
  const seen = new Set();
  const combined = [
    ...(allUsersResult.ok ? allUsersResult.items : []),
    ...(dbResult.ok ? dbResult.items : [])
  ].sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0));

  for (const item of combined) {
    const keyPartId = item.id || '';
    const keyPartTitle = item.title || '';
    const keyPartTime = item.watched_at || 0;
    const dedupeKey = `${keyPartId}:${keyPartTitle}:${keyPartTime}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(item);
    if (merged.length >= limit) break;
  }

  if (merged.length > 0) {
    const payload = {
      items: merged,
      source: (allUsersResult.ok && dbResult.ok)
        ? 'jellyfin-all-users+playback-reporting'
        : (allUsersResult.ok ? 'jellyfin-all-users' : 'playback-reporting')
    };
    setC(key, payload, 15000);
    return res.json(payload);
  }

  // Fallback: user-specific Jellyfin API list.
  const r = await jellyfinRequest(`/Users/${JELLYFIN_USER_ID}/Items?SortBy=DatePlayed&SortOrder=Descending&Limit=${limit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=Movie,Episode`);
  if (!r.ok) return res.json({ items: [], warning: `jellyfin: ${r.error}` });

  const list = r.json?.Items || [];
  const items = list
    .filter((item) => item.UserData?.LastPlayedDate)
    .map((item) => {
      let title = item.Name || 'Unknown';
      let grandparent_title = null;

      if (item.Type === 'Episode') {
        grandparent_title = item.SeriesName;
        if (item.SeasonName && item.IndexNumber) {
          title = `${item.SeasonName} E${item.IndexNumber} - ${item.Name}`;
        }
      }

      return {
        title,
        grandparent_title,
        year: item.ProductionYear || null,
        watched_at: new Date(item.UserData.LastPlayedDate).getTime(),
        media_type: item.Type?.toLowerCase() || '',
        poster: posterFromJellyfin(item)
      };
    })
    .sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0));

  const warning = [allUsersResult.error, dbResult.error].filter(Boolean).join(' | ');
  const payload = { items, source: 'jellyfin-user-fallback', warning };
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

  // Prefer global latest items to avoid single-user visibility limitations.
  let r = await jellyfinRequest(`/Items?SortBy=DateCreated&SortOrder=Descending&Limit=${limit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,DateCreated&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=Movie,Episode`);
  let list = r.ok ? (r.json?.Items || []) : [];
  let source = 'jellyfin-global-items';

  if (!r.ok || !list.length) {
    const fallback = await jellyfinRequest(`/Users/${JELLYFIN_USER_ID}/Items/Latest?Limit=${limit}&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear,DateCreated&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
    if (!fallback.ok) return res.json({ items: [], warning: `jellyfin: ${fallback.error}` });
    list = fallback.json || [];
    source = 'jellyfin-user-latest-fallback';
  }

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

  const payload = { items, source };
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
