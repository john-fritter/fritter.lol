import { getCache, setCache } from '../lib/cache.mjs';
import { safeFetchJson } from '../lib/http.mjs';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

function parsePositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeProviderIds(providerIds = {}) {
  const tmdb = providerIds.Tmdb || providerIds.TMDB || providerIds.tmdb || null;
  const imdb = providerIds.Imdb || providerIds.IMDB || providerIds.imdb || null;

  return {
    tmdb: tmdb ? String(tmdb) : null,
    imdb: imdb ? String(imdb) : null
  };
}

function normalizeFlexibleProviderIds(providerIds = {}) {
  const out = {};
  for (const [rawKey, value] of Object.entries(providerIds || {})) {
    if (value === null || value === undefined || value === '') continue;
    out[String(rawKey).toLowerCase()] = String(value);
  }
  if (!('tmdb' in out)) out.tmdb = null;
  if (!('imdb' in out)) out.imdb = null;
  return out;
}

function normalizeRuntimeTicks(ticks) {
  if (!Number.isFinite(Number(ticks))) return null;
  return Math.round(Number(ticks) / 10_000_000 / 60);
}

function normalizeDateMs(value) {
  if (!value) return null;
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeMovie(item, imageService) {
  const userData = item.UserData || {};
  const addedAt = normalizeDateMs(item.DateCreated);
  const lastPlayedAt = normalizeDateMs(userData.LastPlayedDate);

  return {
    id: item.Id || null,
    title: item.Name || 'Unknown',
    year: item.ProductionYear || null,
    media_type: 'movie',
    provider_ids: normalizeProviderIds(item.ProviderIds),
    poster: imageService.posterFromJellyfinItem(item),
    added_at: addedAt,
    runtime_minutes: normalizeRuntimeTicks(item.RunTimeTicks),
    genres: Array.isArray(item.Genres) ? item.Genres : [],
    official_rating: item.OfficialRating || null,
    community_rating: Number.isFinite(Number(item.CommunityRating)) ? Number(item.CommunityRating) : null,
    critic_rating: Number.isFinite(Number(item.CriticRating)) ? Number(item.CriticRating) : null,
    user_data: {
      played: Boolean(userData.Played),
      play_count: Number.isFinite(Number(userData.PlayCount)) ? Number(userData.PlayCount) : 0,
      last_played_at: lastPlayedAt,
      is_favorite: Boolean(userData.IsFavorite)
    }
  };
}

function applyLocalFilters(items, query) {
  let filtered = items;

  const played = String(query.played || '').trim().toLowerCase();
  const unwatched = normalizeBoolean(query.unwatched, false);
  if (played === 'unwatched' || unwatched) {
    filtered = filtered.filter((item) => !item.user_data.played);
  } else if (played === 'watched' || played === 'played') {
    filtered = filtered.filter((item) => item.user_data.played);
  }

  if (query.genre) {
    const genre = String(query.genre).trim().toLowerCase();
    filtered = filtered.filter((item) => item.genres.some((g) => String(g).toLowerCase() === genre));
  }

  if (query.decade) {
    const start = Number.parseInt(String(query.decade), 10);
    if (Number.isFinite(start)) {
      filtered = filtered.filter((item) => Number.isFinite(item.year) && item.year >= start && item.year < start + 10);
    }
  }

  return filtered;
}

function sortLibrary(items, query) {
  const sort = String(query.sort || 'recently_added').trim().toLowerCase();
  const unwatchedFirst = normalizeBoolean(query.unwatched_first, true);

  return [...items].sort((a, b) => {
    if (unwatchedFirst && a.user_data.played !== b.user_data.played) {
      return a.user_data.played ? 1 : -1;
    }

    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'year') return (b.year || 0) - (a.year || 0);

    return (b.added_at || 0) - (a.added_at || 0);
  });
}

function tmdbPoster(path) {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}${path}`;
}

function normalizeTmdbMovie(item, externalIds = {}) {
  return {
    id: `tmdb:${item.id}`,
    title: item.title || item.original_title || 'Unknown',
    year: Number.isFinite(Number(item.release_date?.slice?.(0, 4))) ? Number(item.release_date.slice(0, 4)) : null,
    media_type: 'movie',
    provider_ids: normalizeFlexibleProviderIds({ tmdb: item.id, imdb: externalIds.imdb_id || null }),
    poster: tmdbPoster(item.poster_path),
    added_at: null,
    runtime_minutes: null,
    genres: [],
    official_rating: null,
    community_rating: Number.isFinite(Number(item.vote_average)) ? Number(item.vote_average) : null,
    critic_rating: null,
    user_data: { played: false, play_count: 0, last_played_at: null, is_favorite: false }
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return null;
}

function normalizeJellyseerrSearchMovie(row) {
  const tmdbId = row?.id;
  if (!tmdbId) return null;
  const releaseDate = firstNonEmptyString(
    row?.releaseDate,
    row?.firstAirDate,
    row?.mediaInfo?.releaseDate
  );
  const year = Number.isFinite(Number(String(releaseDate || '').slice(0, 4)))
    ? Number(String(releaseDate).slice(0, 4))
    : null;
  const imdbId = firstNonEmptyString(row?.imdbId, row?.imdb_id, row?.mediaInfo?.imdbId, row?.mediaInfo?.imdb_id);
  const posterPath = firstNonEmptyString(row?.posterPath, row?.poster_path);

  return {
    id: `tmdb:${tmdbId}`,
    title: row?.title || row?.name || 'Unknown',
    year,
    media_type: 'movie',
    provider_ids: normalizeFlexibleProviderIds({ tmdb: tmdbId, imdb: imdbId || null }),
    poster: tmdbPoster(posterPath),
    added_at: null,
    runtime_minutes: null,
    genres: [],
    official_rating: null,
    community_rating: Number.isFinite(Number(row?.voteAverage)) ? Number(row.voteAverage) : null,
    critic_rating: null,
    user_data: { played: false, play_count: 0, last_played_at: null, is_favorite: false }
  };
}

function normalizeRadarrRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

function isJellyseerrRequestedStatus(status) {
  const numeric = Number(status);
  if (!Number.isFinite(numeric)) return false;
  return numeric === 2 || numeric === 3;
}

function buildJellyseerrSearchVariants(query) {
  const normalized = String(query || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return [];

  const variants = [];
  const seen = new Set();
  const add = (value) => {
    const candidate = String(value || '').trim().replace(/\s+/g, ' ');
    if (!candidate) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(candidate);
  };

  add(normalized);

  const articleStripped = normalized.replace(/^(the|a|an)\s+/i, '').trim();
  add(articleStripped);

  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 1) {
    const significant = words.filter((word) => !/^(the|a|an|of|and|to|in|on|for|at|by|with)$/i.test(word));
    if (significant.length > 0) {
      add(significant.join(' '));
      add(significant[0]);
      if (significant.length > 1) add(significant[significant.length - 1]);
    }
    add(words[0]);
    add(words[words.length - 1]);
  }

  return variants;
}

export function createLibraryService({ config, jellyfinClient, imageService }) {
  const { jellyfin } = config;

  async function fetchTmdbSearch(query, limit) {
    if (!config.tmdb?.apiKey) return { ok: false, error: 'tmdb not configured', results: [] };
    const cacheKey = `tmdb-search-${query}-${limit}`;
    const hit = getCache(cacheKey);
    if (hit) return { ok: true, results: hit };

    const params = new URLSearchParams({
      api_key: config.tmdb.apiKey,
      query,
      include_adult: 'false',
      language: 'en-US',
      page: '1'
    });
    const r = await safeFetchJson(`${config.tmdb.baseUrl}/search/movie?${params}`, { headers: { Accept: 'application/json' } }, config.timeoutMs);
    if (!r.ok) return { ok: false, error: `tmdb: ${r.error}`, results: [] };
    const results = Array.isArray(r.json?.results) ? r.json.results.slice(0, limit) : [];
    setCache(cacheKey, results, 60000);
    return { ok: true, results };
  }

  async function fetchTmdbExternalIds(tmdbId) {
    if (!config.tmdb?.apiKey) return {};
    const cacheKey = `tmdb-external-ids-${tmdbId}`;
    const hit = getCache(cacheKey);
    if (hit) return hit;
    const params = new URLSearchParams({ api_key: config.tmdb.apiKey });
    const r = await safeFetchJson(`${config.tmdb.baseUrl}/movie/${encodeURIComponent(String(tmdbId))}/external_ids?${params}`, { headers: { Accept: 'application/json' } }, config.timeoutMs);
    if (!r.ok) return {};
    const ids = { imdb_id: r.json?.imdb_id || null };
    setCache(cacheKey, ids, 300000);
    return ids;
  }

  async function fetchJellyseerrRequestedIds(query) {
    if (!config.jellyseerr?.configured) return new Set();
    const cacheKey = `jellyseerr-search-${query}`;
    const hit = getCache(cacheKey);
    if (hit) return new Set(hit);
    const params = new URLSearchParams({ query, page: '1', language: 'en' });
    const headers = { Accept: 'application/json', 'X-Api-Key': config.jellyseerr.apiKey };
    const r = await safeFetchJson(`${config.jellyseerr.url}/api/v1/search?${params}`, { headers }, config.timeoutMs);
    if (!r.ok) {
      console.warn('jellyseerr search failed:', r.error);
      return new Set();
    }
    const ids = new Set();
    const rows = Array.isArray(r.json?.results) ? r.json.results : [];
    for (const row of rows) {
      if (row?.mediaType !== 'movie' || !row?.id) continue;
      if (isJellyseerrRequestedStatus(row?.mediaInfo?.status)) ids.add(String(row.id));
    }
    setCache(cacheKey, Array.from(ids), 30000);
    return ids;
  }

  async function fetchJellyseerrSearch(query, limit) {
    if (!config.jellyseerr?.configured) return { ok: false, error: 'jellyseerr not configured', results: [] };
    const cacheKey = `jellyseerr-search-results-${query}-${limit}`;
    const hit = getCache(cacheKey);
    if (hit) return { ok: true, results: hit };
    const headers = { Accept: 'application/json', 'X-Api-Key': config.jellyseerr.apiKey };
    const variants = buildJellyseerrSearchVariants(query);
    if (!variants.length) return { ok: false, error: 'missing query parameter: q', results: [] };

    const normalized = [];
    const seenTmdbIds = new Set();
    let anySuccess = false;
    let lastError = null;
    for (const variant of variants) {
      const params = new URLSearchParams({ query: variant, page: '1', language: 'en' });
      const r = await safeFetchJson(`${config.jellyseerr.url}/api/v1/search?${params}`, { headers }, config.timeoutMs);
      if (!r.ok) {
        lastError = r.error;
        continue;
      }
      anySuccess = true;
      const rows = Array.isArray(r.json?.results) ? r.json.results : [];
      for (const row of rows) {
        if (row?.mediaType !== 'movie') continue;
        const item = normalizeJellyseerrSearchMovie(row);
        const tmdbId = String(item?.provider_ids?.tmdb || '');
        if (!item || !tmdbId || seenTmdbIds.has(tmdbId)) continue;
        seenTmdbIds.add(tmdbId);
        const library_state = isJellyseerrRequestedStatus(row?.mediaInfo?.status) ? 'requested' : 'available';
        normalized.push({ ...item, library_state });
        if (normalized.length >= limit) break;
      }
      if (normalized.length >= limit) break;
    }

    if (!anySuccess) return { ok: false, error: `jellyseerr: ${lastError || 'search failed'}`, results: [] };
    setCache(cacheKey, normalized, 30000);
    return { ok: true, results: normalized };
  }

  async function isRequestedViaRadarr(tmdbId) {
    if (!config.radarr?.configured) return false;
    const cacheKey = `radarr-requested-${tmdbId}`;
    const hit = getCache(cacheKey);
    if (typeof hit === 'boolean') return hit;
    const headers = { Accept: 'application/json', 'X-Api-Key': config.radarr.apiKey };
    const r = await safeFetchJson(`${config.radarr.url}/api/v3/movie?tmdbId=${encodeURIComponent(String(tmdbId))}`, { headers }, config.timeoutMs);
    if (!r.ok) {
      console.warn('radarr lookup failed:', r.error);
      return false;
    }
    const rows = normalizeRadarrRows(r.json);
    const requested = rows.some((row) => Number(row?.tmdbId) === Number(tmdbId) && !Boolean(row?.hasFile));
    setCache(cacheKey, requested, 30000);
    return requested;
  }

  async function getLibrary(query = {}) {
    if (!jellyfin.configured) return { items: [], total: 0, warning: 'jellyfin not configured' };

    const limit = parsePositiveInt(query.limit, 50, { min: 1, max: 200 });
    const startIndex = parsePositiveInt(query.start_index ?? query.startIndex ?? query.offset, 0, { min: 0, max: 100000 });
    const fetchLimit = parsePositiveInt(query.fetch_limit, 2000, { min: limit, max: 5000 });
    const fields = [
      'BasicSyncInfo',
      'CanDelete',
      'CommunityRating',
      'CriticRating',
      'DateCreated',
      'Genres',
      'OfficialRating',
      'ProviderIds',
      'PrimaryImageAspectRatio',
      'ProductionYear',
      'RunTimeTicks'
    ].join(',');
    const params = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie',
      SortBy: 'DateCreated',
      SortOrder: 'Descending',
      Limit: String(fetchLimit),
      Fields: fields,
      ImageTypeLimit: '1',
      EnableImageTypes: 'Primary,Backdrop,Thumb',
      EnableUserData: 'true',
      EnableTotalRecordCount: 'true'
    });

    const response = await jellyfinClient.getUserItems(jellyfin.userId, params.toString());
    if (!response.ok) return { items: [], total: 0, warning: `jellyfin: ${response.error}` };

    const rawItems = Array.isArray(response.json?.Items) ? response.json.Items : [];
    const normalized = rawItems.map((item) => normalizeMovie(item, imageService));
    const filtered = applyLocalFilters(normalized, query);
    const sorted = sortLibrary(filtered, query);
    const pageItems = sorted.slice(startIndex, startIndex + limit);

    return {
      items: pageItems,
      total: filtered.length,
      start_index: startIndex,
      limit,
      source: 'jellyfin-user-items',
      sort: String(query.sort || 'recently_added'),
      unwatched_first: normalizeBoolean(query.unwatched_first, true)
    };
  }

  async function search(query = {}) {
    const q = String(query.q || '').trim();
    if (!q) return { ok: false, status: 400, error: 'missing query parameter: q' };

    const limit = parsePositiveInt(query.limit, 20, { min: 1, max: 50 });
    const libraryResp = await jellyfinClient.searchItems(q, 'Movie');
    const libraryItems = libraryResp.ok
      ? (Array.isArray(libraryResp.json?.Items) ? libraryResp.json.Items : []).map((item) => ({
          ...normalizeMovie(item, imageService),
          library_state: 'in_library'
        }))
      : [];

    const seenLibraryIds = new Set();
    const dedupedLibraryItems = libraryItems.filter((item) => {
      const id = String(item.id || '');
      if (!id || seenLibraryIds.has(id)) return false;
      seenLibraryIds.add(id);
      return true;
    });
    const libraryByTmdb = new Map();
    for (const item of dedupedLibraryItems) {
      if (item.provider_ids?.tmdb) libraryByTmdb.set(String(item.provider_ids.tmdb), item);
    }

    const usingTmdb = Boolean(config.tmdb?.configured);
    const externalSearch = usingTmdb
      ? await fetchTmdbSearch(q, limit)
      : await fetchJellyseerrSearch(q, limit);

    if (!externalSearch.ok && !dedupedLibraryItems.length) {
      return { items: [], total: 0, warning: externalSearch.error || 'search unavailable' };
    }

    const externalItems = [];
    if (usingTmdb) {
      const requestedIds = await fetchJellyseerrRequestedIds(q);
      for (const tmdbItem of externalSearch.results || []) {
        const tmdbId = String(tmdbItem.id);
        if (libraryByTmdb.has(tmdbId)) continue;
        const externalIds = await fetchTmdbExternalIds(tmdbId);
        const normalized = normalizeTmdbMovie(tmdbItem, externalIds);
        let library_state = 'available';
        if (requestedIds.has(tmdbId)) library_state = 'requested';
        else if (await isRequestedViaRadarr(tmdbId)) library_state = 'requested';
        externalItems.push({ ...normalized, library_state });
      }
    } else {
      for (const item of externalSearch.results || []) {
        const tmdbId = String(item?.provider_ids?.tmdb || '');
        if (!tmdbId || libraryByTmdb.has(tmdbId)) continue;
        externalItems.push(item);
      }
    }

    const source = usingTmdb ? 'jellyfin+tmdb' : 'jellyfin+jellyseerr';
    const items = [...dedupedLibraryItems, ...externalItems].slice(0, limit);
    const payload = { items, total: items.length, query: q, limit, source };
    if (!externalSearch.ok) payload.warning = externalSearch.error || 'external search unavailable';
    return payload;
  }

  return { getLibrary, search };
}
