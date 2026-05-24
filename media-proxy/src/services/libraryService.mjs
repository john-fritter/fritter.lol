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

export function createLibraryService({ config, jellyfinClient, imageService }) {
  const { jellyfin } = config;

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

  return { getLibrary };
}
