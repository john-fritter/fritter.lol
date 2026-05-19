export function getConfig(env = process.env) {
  const jellyfinUrl = env.JELLYFIN_URL;
  const jellyfinToken = env.JELLYFIN_TOKEN;
  const jellyfinUserId = env.JELLYFIN_USER_ID;

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
    }
  };
}

export const config = getConfig();
