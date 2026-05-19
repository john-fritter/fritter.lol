import express from 'express';
import { getCache, setCache } from '../lib/cache.mjs';

export function createRecentlyAddedRoutes({ recentlyAddedService }) {
  const router = express.Router();

  router.get('/recently-added', async (req, res) => {
    const limit = Number(req.query.limit || 10);
    const key = `jellyfin-added-${limit}`;
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const payload = await recentlyAddedService.getRecentlyAdded(limit);
    setCache(key, payload, 30000);
    res.json(payload);
  });

  return router;
}
