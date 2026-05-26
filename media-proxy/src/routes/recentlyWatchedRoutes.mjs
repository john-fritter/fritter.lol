import express from 'express';
import { getCache, setCache } from '../lib/cache.mjs';

export function createRecentlyWatchedRoutes({ recentlyWatchedService }) {
  const router = express.Router();

  router.get('/recently-watched', async (req, res) => {
    const limit = Number(req.query.limit || 12);
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    const key = `jellyfin-watched-v2-${limit}-${type.trim().toLowerCase() || 'all'}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const payload = await recentlyWatchedService.getRecentlyWatched(limit, { type });
    setCache(key, payload, 15000);
    res.json(payload);
  });

  return router;
}
