import express from 'express';
import { config as defaultConfig } from './config/env.mjs';
import { createJellyfinClient } from './clients/jellyfinClient.mjs';
import { createPlaybackReportingRepository } from './repositories/playbackReportingRepository.mjs';
import { createImageService } from './services/imageService.mjs';
import { createRecentlyWatchedService } from './services/recentlyWatchedService.mjs';
import { createRecentlyAddedService } from './services/recentlyAddedService.mjs';
import { createLibraryService } from './services/libraryService.mjs';
import { createActivityService } from './services/activityService.mjs';
import { createHealthRoutes } from './routes/healthRoutes.mjs';
import { createImageRoutes } from './routes/imageRoutes.mjs';
import { createRecentlyWatchedRoutes } from './routes/recentlyWatchedRoutes.mjs';
import { createRecentlyAddedRoutes } from './routes/recentlyAddedRoutes.mjs';
import { createLibraryRoutes } from './routes/libraryRoutes.mjs';
import { createActivityRoutes } from './routes/activityRoutes.mjs';
import { createDebugRoutes } from './routes/debugRoutes.mjs';

export function createApp(config = defaultConfig) {
  const app = express();
  const apiRouter = express.Router();

  app.use('/api/media', apiRouter);

  app.use((req, res, next) => {
    console.log(`===== DEBUG =====`);
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    console.log(`Original URL: ${req.originalUrl}`);
    console.log(`Base URL: ${req.baseUrl}`);
    console.log(`Host: ${req.headers.host}`);
    console.log(`Referer: ${req.headers.referer || 'none'}`);
    console.log(`================`);
    next();
  });

  const jellyfinClient = createJellyfinClient(config);
  const playbackRepository = createPlaybackReportingRepository(config);
  const imageService = createImageService(config);
  const recentlyWatchedService = createRecentlyWatchedService({
    config,
    jellyfinClient,
    imageService,
    playbackRepository
  });
  const recentlyAddedService = createRecentlyAddedService({
    config,
    jellyfinClient,
    imageService
  });
  const libraryService = createLibraryService({
    config,
    jellyfinClient,
    imageService
  });
  const activityService = createActivityService({
    config,
    jellyfinClient,
    playbackRepository
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  apiRouter.use(createHealthRoutes({ config }));
  apiRouter.use(createImageRoutes({ imageService }));
  apiRouter.use(createRecentlyWatchedRoutes({ recentlyWatchedService }));
  apiRouter.use(createRecentlyAddedRoutes({ recentlyAddedService }));
  apiRouter.use(createLibraryRoutes({ libraryService }));
  apiRouter.use(createActivityRoutes({ activityService, config }));

  app.get('/', (req, res) => {
    res.json({ message: 'API server running. Use /api/media/* routes to access endpoints.' });
  });

  const debugRoutes = createDebugRoutes({ jellyfinClient, app, apiRouter });
  apiRouter.use(debugRoutes.router);

  app.get('/debug-routes', (req, res) => {
    res.json({ routes: debugRoutes.collectRoutes() });
  });

  return app;
}

export function printRoutes(app) {
  console.log('\n===== REGISTERED ROUTES =====');
  const printStackRoutes = (stack, basePath = '') => {
    stack.forEach(layer => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(',').toUpperCase() || 'ANY';
        console.log(`${basePath ? methods : methods} ${basePath}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const nextBase = basePath || '/api/media';
        printStackRoutes(layer.handle.stack, nextBase);
      }
    });
  };

  printStackRoutes(app._router.stack);
  console.log('===========================\n');
}
