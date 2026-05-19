import Database from 'better-sqlite3';
import { normalizeTimestamp } from '../lib/time.mjs';

export function createPlaybackReportingRepository(config) {
  const dbPath = config.jellyfin.dbPath;

  function openDatabase() {
    if (!dbPath) {
      throw new Error('JELLYFIN_DB_PATH not configured');
    }

    try {
      return new Database(dbPath, { readonly: true });
    } catch (error) {
      throw new Error(`Failed to open Jellyfin database: ${error.message}`);
    }
  }

  function getPlaybackEvents(db, daysBack = 30) {
    try {
      const possibleQueries = [
        `SELECT DateCreated as timestamp FROM PlaybackReporting_PlaybackActivity WHERE DateCreated >= datetime('now', '-${daysBack} days')`,
        `SELECT DatePlayed as timestamp FROM PlaybackReporting_PlaybackActivity WHERE DatePlayed >= datetime('now', '-${daysBack} days')`,
        `SELECT PlaybackReportingId, DateCreated as timestamp FROM PlaybackReporting_PlaybackActivity WHERE DateCreated >= datetime('now', '-${daysBack} days')`,
        `SELECT DateCreated as timestamp FROM PlaybackActivity WHERE DateCreated >= datetime('now', '-${daysBack} days')`,
        `SELECT DatePlayed as timestamp FROM PlaybackActivity WHERE DatePlayed >= datetime('now', '-${daysBack} days')`,
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
        } catch {
          continue;
        }
      }

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      console.log('Available tables in Jellyfin database:', tables.map(t => t.name));

      return [];
    } catch (error) {
      console.error('Error querying playback events:', error.message);
      return [];
    }
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
        const userIdCol = ['UserId', 'UserID', 'UserInternalId']
          .find((c) => cols.includes(c));
        const userNameCol = ['UserName', 'Username']
          .find((c) => cols.includes(c));
        const clientCol = ['ClientName', 'AppName', 'ApplicationName']
          .find((c) => cols.includes(c));
        const deviceCol = ['DeviceName', 'Device', 'DeviceId', 'DeviceID']
          .find((c) => cols.includes(c));

        const selectItemId = itemIdCol ? `${itemIdCol} as item_id` : `NULL as item_id`;
        const selectItemName = itemNameCol ? `${itemNameCol} as item_name` : `NULL as item_name`;
        const selectUserId = userIdCol ? `${userIdCol} as user_id` : `NULL as user_id`;
        const selectUserName = userNameCol ? `${userNameCol} as user_name` : `NULL as user_name`;
        const selectClient = clientCol ? `${clientCol} as client_name` : `NULL as client_name`;
        const selectDevice = deviceCol ? `${deviceCol} as device_name` : `NULL as device_name`;
        const query = `SELECT ${selectItemId}, ${selectItemName}, ${playedCol} as played_at
          , ${selectUserId}, ${selectUserName}, ${selectClient}, ${selectDevice}
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
            played_at: playedAt,
            user_id: row.user_id ? String(row.user_id) : null,
            user_name: row.user_name ? String(row.user_name) : null,
            client_name: row.client_name ? String(row.client_name) : null,
            device_name: row.device_name ? String(row.device_name) : null
          };
        }).filter(Boolean);

        if (normalized.length) return normalized.slice(0, fetchLimit);
      } catch {
        continue;
      }
    }

    return [];
  }

  function getPlaybackEventsFromReportingDb(db, daysBack = 30) {
    const cutoffMs = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const limit = Math.max(daysBack * 300, 1000);
    const rows = getRecentPlaybackRows(db, limit);
    if (!rows.length) return [];

    return rows
      .filter((row) => row.played_at && row.played_at.getTime() >= cutoffMs)
      .map((row) => ({
        timestamp: row.played_at,
        item_id: row.item_id || null,
        item_name: row.item_name || null,
        user_id: row.user_id || null,
        source: 'playback-reporting'
      }));
  }

  return {
    openDatabase,
    getPlaybackEvents,
    getRecentPlaybackRows,
    getPlaybackEventsFromReportingDb
  };
}
