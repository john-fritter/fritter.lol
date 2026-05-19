import express from 'express';

export function createHealthRoutes({ config }) {
  const router = express.Router();

  router.get('/health', (req, res) => res.json({
    ok: true,
    hasJellyfin: config.jellyfin.configured,
    timeoutMs: config.timeoutMs
  }));

  return router;
}
