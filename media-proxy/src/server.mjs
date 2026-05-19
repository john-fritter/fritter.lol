import { config } from './config/env.mjs';
import { createApp, printRoutes } from './app.mjs';

const app = createApp(config);

printRoutes(app);

app.listen(config.port, () => {
  console.log(`\n🚀 media-proxy listening on port ${config.port}`);
  console.log(`Try accessing: http://localhost:${config.port}/`);
  console.log(`API paths: http://localhost:${config.port}/api/media/health`);
  console.log(`Debug: http://localhost:${config.port}/debug-routes`);
});
