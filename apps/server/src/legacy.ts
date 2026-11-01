import type { INestApplication } from '@nestjs/common';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { API_VERSION_HEADER } from '@beatseam/api';
import { AuthConfig } from './auth/auth.config.js';
import { AuthService } from './auth/auth.service.js';
import { SESSION_COOKIE, readCookie } from './auth/cookies.js';
import { createLibraryRouter } from './routes/library.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sign-in for the pre-v1 Express routes, which live outside Nest's guard. Same rules: a real
 * session (these predate device tokens and stay browser-only), finished enrollment, no cross-site
 * writes. Writing (the playlist PUT) additionally needs an admin, since it edits the shared library.
 */
function legacyAuth(auth: AuthService, config: AuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const unsafe = !SAFE_METHODS.has(req.method);
      if (unsafe && req.headers.origin && !config.allowedOrigins(req).includes(req.headers.origin)) {
        res.status(403).json({ error: 'Cross-origin request refused' });
        return;
      }
      const principal = await auth.authenticate({ sessionToken: readCookie(req.headers.cookie, SESSION_COOKIE) });
      if (!principal) {
        res.status(401).json({ error: 'Sign in required' });
        return;
      }
      if (!principal.user.enrolled) {
        res.status(403).json({ error: 'Finish setting up how you sign in first', code: 'enrollment_required' });
        return;
      }
      if (unsafe && !req.headers[API_VERSION_HEADER.toLowerCase()]) {
        res.status(403).json({ error: `Missing ${API_VERSION_HEADER} header` });
        return;
      }
      if (unsafe && principal.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Not allowed' });
        return;
      }
      next();
    })().catch(next);
  };
}

export interface LegacyOptions {
  libraryRoot: string;
  lyricsRootIds: ReadonlySet<string>;
}

/**
 * The original file routes (static `/library` and `/api/roots...`), kept until the clients move
 * to /api/v1. Mount before app.init(), so they run ahead of the Nest routes and the SPA fallback.
 */
export function mountLegacyRoutes(app: INestApplication, options: LegacyOptions): void {
  const guard = legacyAuth(app.get(AuthService), app.get(AuthConfig));
  // Audio bytes (and any other file - .lrc lyrics, etc) are served by mounting the library
  // directory straight into express.static: Range/ETag/If-Modified-Since support for free.
  app.use('/library', guard, express.static(options.libraryRoot, { index: false }));
  // A separate guard mount, ahead of the router: mounting the guard on '/api' itself would also
  // catch the public /api/v1 routes.
  app.use('/api/roots', guard);
  app.use('/api', createLibraryRouter(options.libraryRoot, options.lyricsRootIds));
}
