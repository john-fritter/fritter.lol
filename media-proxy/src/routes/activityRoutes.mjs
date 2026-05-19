import express from 'express';
import { getCache, setCache } from '../lib/cache.mjs';

export function createActivityRoutes({ activityService, config }) {
  const router = express.Router();

  router.get('/activity/weekly', async (req, res) => {
    const key = 'jellyfin-activity-weekly';
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const payload = await activityService.getWeeklyActivity();
    setCache(key, payload, 30000);
    res.json(payload);
  });

  router.get('/activity/monthly', async (req, res) => {
    const key = 'jellyfin-activity-monthly';
    const hit = getCache(key);
    if (hit) return res.json(hit);

    const payload = await activityService.getMonthlyActivity();
    setCache(key, payload, 30000);
    res.json(payload);
  });

  router.get('/activity/debug/events', async (req, res) => {
    try {
      return res.json(await activityService.getDebugEvents(req.query.limit));
    } catch (error) {
      return res.status(500).json({
        error: error.message,
        timezone: config.activityTimezone
      });
    }
  });

  return router;
}
