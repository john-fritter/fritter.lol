import { normalizeTimestamp } from '../lib/time.mjs';
import { normalizeKey } from '../lib/normalize.mjs';

export function createRecentlyWatchedService({ config, jellyfinClient, imageService, playbackRepository }) {
  const { jellyfin } = config;
  const RECENTLY_WATCHED_TYPE_FILTERS = {
    movie: (item) => item?.media_type === 'movie'
  };

  function applyTypeFilter(items, type) {
    const normalizedType = String(type || '').trim().toLowerCase();
    if (!normalizedType) return items;
    const filter = RECENTLY_WATCHED_TYPE_FILTERS[normalizedType];
    if (!filter) return items;
    return items.filter(filter);
  }

  async function getRecentWatchedAllUsers(limit = 12, resultLimit = limit) {
    const usersResp = await jellyfinClient.getUsers();
    if (!usersResp.ok || !Array.isArray(usersResp.json) || usersResp.json.length === 0) {
      return { ok: false, error: usersResp.error || 'Unable to read Jellyfin users' };
    }

    const users = usersResp.json.filter((u) => u && u.Id && !u.Policy?.IsDisabled);
    if (!users.length) return { ok: false, error: 'No enabled Jellyfin users found' };

    const perUserLimit = Math.max(limit * 3, 30);
    const perUserResults = await Promise.all(users.map(async (user) => {
      const r = await jellyfinClient.request(`/Users/${user.Id}/Items?SortBy=DatePlayed&SortOrder=Descending&Limit=${perUserLimit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=Movie,Episode`);
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
            poster: imageService.posterFromJellyfinItem(item)
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
      if (deduped.length >= resultLimit) break;
    }

    return { ok: true, items: deduped };
  }

  async function getRecentWatchedFromActivityLog(limit = 12, resultLimit = limit) {
    const fetchLimit = Math.max(limit * 10, 120);
    const r = await jellyfinClient.getActivityLog(fetchLimit);
    if (!r.ok) return { ok: false, error: r.error || 'Unable to read Jellyfin activity log' };

    const entries = r.json?.Items || r.json?.items || r.json?.Entries || [];
    if (!Array.isArray(entries) || !entries.length) {
      return { ok: false, error: 'No activity log entries found' };
    }

    const isPlaybackEntry = (entry) => {
      const hay = `${entry?.Type || ''} ${entry?.Name || ''} ${entry?.ShortOverview || ''} ${entry?.Overview || ''}`.toLowerCase();
      return hay.includes('playback') || hay.includes('played') || hay.includes('stopped');
    };

    const normalizeTitle = (entry) => {
      const candidates = [
        entry?.ItemName,
        entry?.Name,
        entry?.ShortOverview,
        entry?.Overview
      ].filter(Boolean);
      if (!candidates.length) return 'Unknown';
      let title = String(candidates[0]);
      title = title.replace(/^[^:]{1,64}:\s*/, '');
      title = title.replace(/^.+?\bhas finished playing\b\s+/i, '');
      title = title.replace(/^.+?\bhas started playing\b\s+/i, '');
      title = title.replace(/^.+?\bplayed\b\s+/i, '');
      title = title.replace(/\s+\bon\b\s+.+$/i, '');
      return title.trim() || 'Unknown';
    };

    const hydratedItemCache = new Map();
    async function hydrateItem(item) {
      if (!item?.Id) return item || null;
      const key = String(item.Id);
      if (hydratedItemCache.has(key)) return hydratedItemCache.get(key);
      const full = await jellyfinClient.getItem(key);
      const result = (full.ok && full.json?.Id) ? full.json : item;
      hydratedItemCache.set(key, result);
      return result;
    }

    const findByTitleCache = new Map();
    async function findItemByTitle(title) {
      const key = normalizeKey(title);
      if (!key) return null;
      if (findByTitleCache.has(key)) return findByTitleCache.get(key);

      const parts = String(title).split(' - ').map((p) => p.trim()).filter(Boolean);
      const seriesPart = parts.length >= 2 ? parts[0] : '';
      const episodePart = parts.length >= 2 ? parts[parts.length - 1] : '';
      const episodeNoPrefix = episodePart.replace(/^s\d+e\d+\s*[-:]?\s*/i, '').trim();

      const searchCandidates = [
        title,
        episodePart,
        episodeNoPrefix,
        seriesPart ? `${seriesPart} ${episodeNoPrefix || episodePart}`.trim() : '',
        seriesPart
      ].map((v) => String(v || '').trim()).filter(Boolean);

      let best = null;
      let bestScore = -1;

      for (const candidate of searchCandidates) {
        const r = await jellyfinClient.searchItems(candidate);
        if (!r.ok) continue;
        const list = Array.isArray(r.json?.Items) ? r.json.Items : [];
        const nkCandidate = normalizeKey(candidate);
        const nkTitle = normalizeKey(title);
        const nkSeries = normalizeKey(seriesPart);
        const nkEpisode = normalizeKey(episodeNoPrefix || episodePart);

        for (const item of list) {
          const nkName = normalizeKey(item?.Name || '');
          const nkSeriesName = normalizeKey(item?.SeriesName || '');
          let score = 0;

          if (nkName && nkName === nkTitle) score += 120;
          if (nkName && nkName === nkCandidate) score += 100;
          if (nkSeries && nkSeriesName && nkSeriesName === nkSeries) score += 45;
          if (nkEpisode && nkName && nkName === nkEpisode) score += 45;
          if (nkEpisode && nkName && nkName.includes(nkEpisode)) score += 25;
          if (nkCandidate && nkName && nkName.includes(nkCandidate)) score += 15;
          if (item?.Type === 'Episode') score += 5;

          if (score > bestScore) {
            bestScore = score;
            best = item;
          }
        }

        if (bestScore >= 120) break;
      }

      const hydrated = await hydrateItem(best);
      findByTitleCache.set(key, hydrated);
      return hydrated;
    }

    const rows = entries
      .filter(isPlaybackEntry)
      .map((entry) => {
        const watchedAtDate = normalizeTimestamp(entry?.Date || entry?.DateCreated || entry?.Timestamp || entry?.Time);
        if (!watchedAtDate) return null;
        const itemId = entry?.ItemId ? String(entry.ItemId) : null;
        const cleanedTitle = normalizeTitle(entry);
        return {
          id: itemId,
          user_id: entry?.UserId ? String(entry.UserId) : null,
          title: cleanedTitle,
          grandparent_title: null,
          year: null,
          watched_at: watchedAtDate.getTime(),
          media_type: '',
          poster: null
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0));

    if (!rows.length) return { ok: false, error: 'No playback events in activity log' };

    const itemIds = [...new Set(rows.map((x) => x.id).filter(Boolean))].slice(0, Math.max(limit * 3, 30));
    const detailsMap = new Map();

    await Promise.all(itemIds.map(async (itemId) => {
      const d = await jellyfinClient.getItem(itemId);
      if (d.ok && d.json?.Id) detailsMap.set(itemId, d.json);
    }));

    const items = [];
    for (const row of rows) {
      if (items.length >= resultLimit) break;
      let detail = row.id ? detailsMap.get(row.id) : null;
      if (!detail) {
        detail = await findItemByTitle(row.title);
      }
      if (detail) {
        let title = detail.Name || row.title;
        let grandparent_title = null;
        if (detail.Type === 'Episode') {
          grandparent_title = detail.SeriesName || null;
          if (detail.SeasonName && detail.IndexNumber) {
            title = `${detail.SeasonName} E${detail.IndexNumber} - ${detail.Name || row.title}`;
          }
        }
        let poster = imageService.posterFromJellyfinItem(detail);
        if (!poster && detail.Id) {
          poster = imageService.fallbackPrimaryPoster(detail.Id);
        }

        items.push({
          id: detail.Id || row.id || null,
          user_id: row.user_id || null,
          title,
          grandparent_title,
          year: detail.ProductionYear || null,
          watched_at: row.watched_at,
          media_type: detail.Type?.toLowerCase() || '',
          poster
        });
      } else {
        items.push(row);
      }
    }

    return { ok: true, items };
  }

  async function getRecentWatchedFromPlaybackDb(limit = 12, resultLimit = limit) {
    if (!jellyfin.dbPath) {
      return { ok: false, error: 'JELLYFIN_DB_PATH not configured' };
    }

    let db;
    try {
      db = playbackRepository.openDatabase();
      const rows = playbackRepository.getRecentPlaybackRows(db, limit);
      if (!rows.length) {
        return { ok: false, error: 'No playback rows found in reporting DB' };
      }

      const recentRows = rows.slice(0, limit * 3);
      const itemIds = [...new Set(recentRows.map((r) => r.item_id).filter(Boolean))].slice(0, limit * 3);
      const detailsMap = new Map();

      await Promise.all(itemIds.map(async (itemId) => {
        const globalItem = await jellyfinClient.getItem(itemId);
        if (globalItem.ok && globalItem.json?.Id) return detailsMap.set(itemId, globalItem.json);
        const scopedItem = await jellyfinClient.request(`/Users/${jellyfin.userId}/Items/${encodeURIComponent(itemId)}?Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`);
        if (scopedItem.ok && scopedItem.json?.Id) detailsMap.set(itemId, scopedItem.json);
      }));

      const items = [];
      for (const row of recentRows) {
        if (items.length >= resultLimit) break;
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
          poster: detail ? imageService.posterFromJellyfinItem(source) : null
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

  async function getRecentlyWatched(limit = 12, options = {}) {
    const filteredType = String(options?.type || '').trim().toLowerCase();
    if (!jellyfin.configured) return { items: [], warning: 'jellyfin not configured' };

    const sourceLimit = Math.max(limit * 4, 48);
    const allUsersResult = await getRecentWatchedAllUsers(limit, sourceLimit);
    const dbResult = await getRecentWatchedFromPlaybackDb(limit, sourceLimit);
    const activityLogResult = await getRecentWatchedFromActivityLog(limit, sourceLimit);

    const merged = [];
    const recentByMediaKey = new Map();
    const combined = [
      ...(allUsersResult.ok ? allUsersResult.items : []),
      ...(dbResult.ok ? dbResult.items : []),
      ...(activityLogResult.ok ? activityLogResult.items : [])
    ].sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0));

    const DUP_WINDOW_MS = 12 * 60 * 60 * 1000;
    const normalizeTitle = (item) => `${String(item.grandparent_title || '').trim().toLowerCase()}::${String(item.title || '').trim().toLowerCase()}`;
    for (const item of combined) {
      const idKey = item.id ? `id:${item.id}` : null;
      const titleKey = `title:${normalizeTitle(item)}`;
      const ts = Number(item.watched_at || 0);

      const lastById = idKey ? recentByMediaKey.get(idKey) : null;
      const lastByTitle = recentByMediaKey.get(titleKey);
      const isDupById = lastById && Math.abs(lastById - ts) <= DUP_WINDOW_MS;
      const isDupByTitle = lastByTitle && Math.abs(lastByTitle - ts) <= DUP_WINDOW_MS;
      if (isDupById || isDupByTitle) continue;
      if (idKey) recentByMediaKey.set(idKey, ts);
      recentByMediaKey.set(titleKey, ts);

      merged.push(item);
      if (!filteredType && merged.length >= limit) break;
    }

    if (merged.length > 0) {
      const filteredItems = applyTypeFilter(merged, filteredType).slice(0, limit);
      return {
        items: filteredItems,
        source: [
          allUsersResult.ok ? 'all-users' : null,
          dbResult.ok ? 'playback-reporting' : null,
          activityLogResult.ok ? 'activity-log' : null
        ].filter(Boolean).join('+')
      };
    }

    const fallbackLimit = filteredType === 'movie' ? sourceLimit : limit;
    const fallbackIncludeItemTypes = filteredType === 'movie' ? 'Movie' : 'Movie,Episode';
    const r = await jellyfinClient.request(`/Users/${jellyfin.userId}/Items?SortBy=DatePlayed&SortOrder=Descending&Limit=${fallbackLimit}&Recursive=true&Fields=BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&IncludeItemTypes=${fallbackIncludeItemTypes}`);
    if (!r.ok) return { items: [], warning: `jellyfin: ${r.error}` };

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
          poster: imageService.posterFromJellyfinItem(item)
        };
      })
      .sort((a, b) => (b.watched_at || 0) - (a.watched_at || 0));

    const warning = [allUsersResult.error, dbResult.error].filter(Boolean).join(' | ');
    const extraWarning = activityLogResult.error ? `${warning ? `${warning} | ` : ''}${activityLogResult.error}` : warning;
    const filteredItems = applyTypeFilter(items, filteredType).slice(0, limit);
    return { items: filteredItems, source: 'jellyfin-user-fallback', warning: extraWarning };
  }

  return {
    getRecentlyWatched,
    getRecentWatchedAllUsers,
    getRecentWatchedFromActivityLog,
    getRecentWatchedFromPlaybackDb
  };
}
