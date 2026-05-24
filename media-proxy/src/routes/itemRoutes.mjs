import express from 'express';
import { getCache, setCache } from '../lib/cache.mjs';

export function createItemRoutes({ itemService }) {
  const router = express.Router();

  router.get('/items/:id', async (req, res) => {
    const { id } = req.params;
    const cacheKey = `jellyfin-item-${id}`;

    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const result = await itemService.getItem(id);

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }

    setCache(cacheKey, result.item, 30000);
    res.json(result.item);
  });

  return router;
}
