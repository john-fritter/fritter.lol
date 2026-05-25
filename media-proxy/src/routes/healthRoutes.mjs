import express from 'express';

export function createHealthRoutes({ config }) {
  const router = express.Router();

  router.get('/health', (req, res) => res.json({
    ok: true,
    hasJellyfin: config.jellyfin.configured,
    hasTmdb: Boolean(config.tmdb?.configured),
    hasJellyseerr: Boolean(config.jellyseerr?.configured),
    hasRadarr: Boolean(config.radarr?.configured),
    hasExternalSearch: Boolean(config.tmdb?.configured || config.jellyseerr?.configured),
    timeoutMs: config.timeoutMs
  }));

  return router;
}
