import { normalizeTimestamp, getActivityDateParts, getWeeklyBucketForDate, buildMonthlyBucketMap } from '../lib/time.mjs';
import { normalizeKey } from '../lib/normalize.mjs';

export function createActivityService({ config, jellyfinClient, playbackRepository }) {
  const timezone = config.activityTimezone;

  async function getPlaybackEventsFromActivityLog(daysBack = 30) {
    const cutoffMs = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const fetchLimit = Math.max(daysBack * 250, 1000);
    const r = await jellyfinClient.getActivityLog(fetchLimit);
    if (!r.ok) return { ok: false, error: r.error || 'Unable to read Jellyfin activity log', events: [] };

    const entries = Array.isArray(r.json?.Items) ? r.json.Items : [];
    if (!entries.length) return { ok: false, error: 'No activity log entries found', events: [] };

    const isPlaybackEntry = (entry) => {
      const hay = `${entry?.Type || ''} ${entry?.Name || ''} ${entry?.ShortOverview || ''} ${entry?.Overview || ''}`.toLowerCase();
      return hay.includes('playback') || hay.includes('played') || hay.includes('stopped');
    };

    const normalizeItemName = (entry) => {
      const base = entry?.ItemName || entry?.Name || entry?.ShortOverview || entry?.Overview || '';
      return String(base)
        .replace(/^[^:]{1,64}:\s*/, '')
        .replace(/^.+?\bhas finished playing\b\s+/i, '')
        .replace(/^.+?\bhas started playing\b\s+/i, '')
        .replace(/^.+?\bplayed\b\s+/i, '')
        .replace(/\s+\bon\b\s+.+$/i, '')
        .trim() || null;
    };

    const events = entries
      .filter(isPlaybackEntry)
      .map((entry) => {
        const date = normalizeTimestamp(entry?.Date || entry?.DateCreated || entry?.Timestamp || entry?.Time);
        if (!date || date.getTime() < cutoffMs) return null;
        return {
          timestamp: date,
          item_id: entry?.ItemId ? String(entry.ItemId) : null,
          item_name: normalizeItemName(entry),
          user_id: entry?.UserId ? String(entry.UserId) : null,
          source: 'activity-log'
        };
      })
      .filter(Boolean);

    if (!events.length) return { ok: false, error: `No playback events in last ${daysBack} days from activity log`, events: [] };
    return { ok: true, events };
  }

  async function getUnifiedPlaybackEvents(daysBack = 30) {
    const warnings = [];
    const combined = [];

    if (config.jellyfin.dbPath) {
      let db = null;
      try {
        db = playbackRepository.openDatabase();
        const dbEvents = playbackRepository.getPlaybackEventsFromReportingDb(db, daysBack);
        if (dbEvents.length) combined.push(...dbEvents);
        else warnings.push('No playback events found in reporting DB for selected range');
      } catch (error) {
        warnings.push(`Reporting DB error: ${error.message}`);
      } finally {
        if (db) {
          try { db.close(); } catch {}
        }
      }
    } else {
      warnings.push('JELLYFIN_DB_PATH not configured');
    }

    if (config.jellyfin.configured) {
      const logResult = await getPlaybackEventsFromActivityLog(daysBack);
      if (logResult.ok && logResult.events.length) combined.push(...logResult.events);
      else if (logResult.error) warnings.push(logResult.error);
    } else {
      warnings.push('Jellyfin API credentials not configured');
    }

    const deduped = [];
    const seen = new Set();
    for (const event of combined.sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0))) {
      const ts = event.timestamp?.getTime();
      if (!Number.isFinite(ts)) continue;
      const minuteBucket = Math.floor(ts / 60000);
      const user = normalizeKey(event.user_id) || 'unknown-user';
      const item = normalizeKey(event.item_id || event.item_name) || 'unknown-item';
      const key = `${user}|${item}|${minuteBucket}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }

    const bySource = (rows) => rows.reduce((acc, row) => {
      const key = row?.source || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return {
      events: deduped.sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0)),
      warning: warnings.length ? warnings.join(' | ') : null,
      stats: {
        combined_count: combined.length,
        deduped_count: deduped.length,
        combined_by_source: bySource(combined),
        deduped_by_source: bySource(deduped)
      }
    };
  }

  function buildWeeklyActivityData(events) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
    const data = {};
    const partsFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      hour12: false
    });

    for (const day of days) {
      for (const block of timeBlocks) {
        data[`${day}_${block}`] = 0;
      }
    }

    for (const event of events) {
      const date = event.timestamp;
      const parts = partsFormatter.formatToParts(date);
      const dayName = parts.find((p) => p.type === 'weekday')?.value;
      const hourStr = parts.find((p) => p.type === 'hour')?.value;
      const hour = Number(hourStr) % 24;
      if (!dayName || !days.includes(dayName) || !Number.isFinite(hour)) continue;

      const blockIndex = Math.floor(hour / 3);
      const blockName = timeBlocks[blockIndex];

      const key = `${dayName}_${blockName}`;
      if (data[key] !== undefined) data[key]++;
    }

    return data;
  }

  function buildMonthlyActivityData(events) {
    const data = {};
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const dayKeyToBucket = new Map();

    for (let i = 1; i <= 30; i++) {
      data[`day_${i}`] = 0;
      const date = new Date(now - ((30 - i) * dayMs));
      dayKeyToBucket.set(dateFormatter.format(date), `day_${i}`);
    }

    for (const event of events) {
      const bucket = dayKeyToBucket.get(dateFormatter.format(event.timestamp));
      if (bucket && data[bucket] !== undefined) data[bucket]++;
    }

    return data;
  }

  async function getWeeklyActivity() {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const timeBlocks = ['00-03', '03-06', '06-09', '09-12', '12-15', '15-18', '18-21', '21-24'];
    const emptyData = {};

    for (const day of days) {
      for (const block of timeBlocks) {
        emptyData[`${day}_${block}`] = 0;
      }
    }

    try {
      const { events, warning } = await getUnifiedPlaybackEvents(7);
      if (events.length === 0) {
        return { data: emptyData, warning: warning || 'No playback events found in the last 7 days' };
      }
      return { data: buildWeeklyActivityData(events) };
    } catch (error) {
      console.error('Error reading Jellyfin playback data for weekly activity:', error.message);
      return { data: emptyData, warning: `Database error: ${error.message}` };
    }
  }

  async function getMonthlyActivity() {
    const emptyData = {};
    for (let i = 1; i <= 30; i++) emptyData[`day_${i}`] = 0;

    try {
      const { events, warning } = await getUnifiedPlaybackEvents(30);
      if (events.length === 0) {
        return { data: emptyData, warning: warning || 'No playback events found in the last 30 days' };
      }
      return { data: buildMonthlyActivityData(events) };
    } catch (error) {
      console.error('Error reading Jellyfin playback data for monthly activity:', error.message);
      return { data: emptyData, warning: `Database error: ${error.message}` };
    }
  }

  async function getDebugEvents(limit = 250) {
    const maxRows = 1000;
    const appliedLimit = Math.max(1, Math.min(Number(limit || 250), maxRows));
    const monthlyBucketMap = buildMonthlyBucketMap(timezone);
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    const [weekly, monthly] = await Promise.all([
      getUnifiedPlaybackEvents(7),
      getUnifiedPlaybackEvents(30)
    ]);

    const serialize = (event) => {
      const parts = getActivityDateParts(event.timestamp, timezone);
      return {
        source: event.source || null,
        user_id: event.user_id || null,
        item_id: event.item_id || null,
        item_name: event.item_name || null,
        timestamp_ms: event.timestamp.getTime(),
        timestamp_utc: event.timestamp.toISOString(),
        local_date: parts.local_date,
        local_time: parts.local_time,
        local_weekday: parts.weekday,
        local_hour_24: parts.hour,
        weekly_bucket: getWeeklyBucketForDate(event.timestamp, timezone),
        monthly_bucket: monthlyBucketMap.get(dateFormatter.format(event.timestamp)) || null
      };
    };

    return {
      timezone,
      generated_at_utc: new Date().toISOString(),
      limit_applied: appliedLimit,
      weekly: {
        warning: weekly.warning || null,
        total_events: weekly.events.length,
        stats: weekly.stats || null,
        events: weekly.events
          .slice()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, appliedLimit)
          .map(serialize)
      },
      monthly: {
        warning: monthly.warning || null,
        total_events: monthly.events.length,
        stats: monthly.stats || null,
        events: monthly.events
          .slice()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, appliedLimit)
          .map(serialize)
      }
    };
  }

  return {
    getPlaybackEventsFromActivityLog,
    getUnifiedPlaybackEvents,
    buildWeeklyActivityData,
    buildMonthlyActivityData,
    getWeeklyActivity,
    getMonthlyActivity,
    getDebugEvents
  };
}
