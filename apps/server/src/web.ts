import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express, { type RequestHandler } from 'express';
import { isAccountPath } from './pages/paths.js';

/**
 * Serves the built web app: static files, plus index.html for any other page
 * route so client-side routing survives a reload. Must be mounted BEFORE
 * app.init() - Nest installs its own 404 handler during init, and anything
 * added after it is never reached. Because it therefore runs ahead of the Nest
 * routes, the fallback steps aside for API, file and account-page paths.
 */
export function mountWebApp(app: INestApplication, webDist: string): void {
  const pageFallback: RequestHandler = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/') || req.path.startsWith('/library/') || isAccountPath(req.path)) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'), (err: unknown) => {
      if (err) next();
    });
  };
  app.use(express.static(webDist));
  app.use(pageFallback);
}
