import express from 'express';
import { getCache, setCache } from '../lib/cache.mjs';

export function createLibraryRoutes({ libraryService }) {
  const router = express.Router();

  router.get('/library', async (req, res) => {
    const cacheKey = `jellyfin-library-${JSON.stringify(req.query)}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const payload = await libraryService.getLibrary(req.query);
    setCache(cacheKey, payload, 30000);
    res.json(payload);
  });

  return router;
}
