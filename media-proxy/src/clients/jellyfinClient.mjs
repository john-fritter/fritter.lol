import { safeFetchJson } from '../lib/http.mjs';

export function createJellyfinClient(config) {
  const { jellyfin, timeoutMs } = config;

  async function request(endpoint, timeout = timeoutMs) {
    if (!jellyfin.configured) return { ok: false, error: 'jellyfin not configured' };

    const url = `${jellyfin.url}${endpoint}`;
    const headers = {
      'Authorization': `MediaBrowser Token="${jellyfin.token}"`,
      'Accept': 'application/json'
    };

    return safeFetchJson(url, { headers }, timeout);
  }

  return {
    request,
    hasConfig: jellyfin.configured,
    getSystemInfo: () => request('/System/Info'),
    getUsers: () => request('/Users'),
    getItem: (id, fields = 'BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear') =>
      request(`/Items/${encodeURIComponent(id)}?Fields=${fields}&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb`),
    searchItems: (query, includeTypes = 'Movie,Episode,Video') =>
      request(`/Items?SearchTerm=${encodeURIComponent(query)}&Recursive=true&Limit=25&IncludeItemTypes=${includeTypes}&Fields=BasicSyncInfo,CanDelete,CommunityRating,CriticRating,DateCreated,Genres,OfficialRating,ProviderIds,PrimaryImageAspectRatio,ProductionYear,RunTimeTicks&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop,Thumb&EnableUserData=true`),
    getUserItems: (userId, query) => request(`/Users/${encodeURIComponent(userId)}/Items?${query}`),
    getActivityLog: (limit) => request(`/System/ActivityLog/Entries?Limit=${limit}&HasUserId=true`)
  };
}
