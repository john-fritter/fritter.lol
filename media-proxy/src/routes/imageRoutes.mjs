import express from 'express';

export function createImageRoutes({ imageService }) {
  const router = express.Router();

  router.get('/img', (req, res) => imageService.proxyImage(req, res));

  return router;
}
