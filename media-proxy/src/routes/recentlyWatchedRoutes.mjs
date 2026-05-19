import express from 'express';
import { getCache, setCache } from '../lib/cache.mjs';

export function createRecentlyWatchedRoutes({ recentlyWatchedService }) {
  const router = express.Router();

  router.get('/recently-watched', async (req, res) => {
    const limit = Number(req.query.limit || 12);
    const key = `jellyfin-watched-v2-${limit}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const payload = await recentlyWatchedService.getRecentlyWatched(limit);
    setCache(key, payload, 15000);
    res.json(payload);
  });

  return router;
}
