export function getConfig(env = process.env) {
  const jellyfinUrl = env.JELLYFIN_URL;
  const jellyfinToken = env.JELLYFIN_TOKEN;
  const jellyfinUserId = env.JELLYFIN_USER_ID;
  const tmdbApiKey = env.TMDB_API_KEY;
  const jellyseerrUrl = env.JELLYSEERR_URL;
  const jellyseerrApiKey = env.JELLYSEERR_API_KEY;
  const radarrUrl = env.RADARR_URL;
  const radarrApiKey = env.RADARR_API_KEY;

  return {
    port: env.PORT || 8080,
    timeoutMs: Number(env.TIMEOUT_MS || 1500),
    activityTimezone: env.ACTIVITY_TIMEZONE || 'America/Los_Angeles',
    jellyfin: {
      url: jellyfinUrl,
      token: jellyfinToken,
      userId: jellyfinUserId,
      dbPath: env.JELLYFIN_DB_PATH,
      configured: !!(jellyfinUrl && jellyfinToken && jellyfinUserId)
    },
    tmdb: {
      apiKey: tmdbApiKey,
      baseUrl: env.TMDB_API_BASE_URL || 'https://api.themoviedb.org/3',
      configured: !!tmdbApiKey
    },
    jellyseerr: {
      url: jellyseerrUrl,
      apiKey: jellyseerrApiKey,
      configured: !!(jellyseerrUrl && jellyseerrApiKey)
    },
    radarr: {
      url: radarrUrl,
      apiKey: radarrApiKey,
      configured: !!(radarrUrl && radarrApiKey)
    }
  };
}

export const config = getConfig();
