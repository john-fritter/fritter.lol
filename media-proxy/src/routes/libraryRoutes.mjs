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

  router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const cacheKey = `media-search-${q}-${JSON.stringify(req.query)}`;
    const hit = getCache(cacheKey);
    if (hit) return res.json(hit);

    const payload = await libraryService.search(req.query);
    if (payload.ok === false) {
      return res.status(payload.status || 400).json({ error: payload.error || 'invalid query' });
    }

    setCache(cacheKey, payload, 30000);
    return res.json(payload);
  });

  return router;
}
