import express from 'express';

export function createDebugRoutes({ jellyfinClient, app, apiRouter, apiBasePath = '/api/media' }) {
  const router = express.Router();

  router.get('/debug/jellyfin-info', async (req, res) => {
    if (!jellyfinClient.hasConfig) return res.json({ error: 'jellyfin not configured' });

    try {
      const r = await jellyfinClient.getSystemInfo();
      if (!r.ok) return res.json({ error: `jellyfin: ${r.error}` });

      return res.json({
        success: true,
        server_info: {
          version: r.json?.Version,
          name: r.json?.ServerName,
          id: r.json?.Id
        }
      });
    } catch (err) {
      return res.json({ error: err.message });
    }
  });

  function collectRoutes() {
    const routes = [];

    const collectFromStack = (stack, basePath = '') => {
      stack.forEach((layer) => {
        if (layer.route) {
          routes.push({
            path: `${basePath}${layer.route.path}`,
            methods: Object.keys(layer.route.methods).join(',')
          });
        } else if (layer.name === 'router' && layer.handle?.stack) {
          collectFromStack(layer.handle.stack, basePath);
        }
      });
    };

    app._router.stack.forEach((middleware) => {
      if (middleware.route) {
        routes.push({
          path: middleware.route.path,
          methods: Object.keys(middleware.route.methods).join(',')
        });
      }
    });

    if (apiRouter?._router?.stack) collectFromStack(apiRouter._router.stack, apiBasePath);
    else if (apiRouter?.stack) collectFromStack(apiRouter.stack, apiBasePath);

    return routes;
  }

  return {
    router,
    collectRoutes
  };
}
