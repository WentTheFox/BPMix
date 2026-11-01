import 'reflect-metadata';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureHttp } from './http.js';
import { mountLegacyRoutes } from './legacy.js';
import { mountWebApp } from './web.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT ?? 8080);
// Every top-level subdirectory mounted under this path becomes a library root -
// e.g. `docker run -v ~/Music:/music/MyLibrary` needs no further config.
const libraryRoot = process.env.BEATSEAM_LIBRARY_ROOT ?? '/music';
// Comma-separated top-level subdirectory names (under libraryRoot) that hold
// only .lrc files rather than playable tracks - e.g. `-v ~/Lyrics:/music/Lyrics`
// plus `BEATSEAM_LYRICS_ROOTS=Lyrics`. Marked kind:'lyrics' in /api/roots so the
// client scans them as a lyrics scope instead of a (permanently empty) library.
const lyricsRootIds = new Set(
  (process.env.BEATSEAM_LYRICS_ROOTS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);
// apps/web/dist is copied alongside dist/main.js in the Docker runtime image (see Dockerfile).
const webDist = process.env.BEATSEAM_WEB_DIST ?? path.resolve(dirname, '../web');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  configureHttp(app);

  // Behind a reverse proxy, req.ip / req.protocol (rate limits, secure cookies) come from X-Forwarded-*,
  // but only if told how many proxies to trust: BEATSEAM_TRUST_PROXY=1, or a subnet name like loopback.
  const trustProxy = process.env.BEATSEAM_TRUST_PROXY;
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy);

  // Legacy file routes (now behind sign-in), kept until clients move to /api/v1.
  mountLegacyRoutes(app, { libraryRoot, lyricsRootIds });

  mountWebApp(app, webDist);

  await app.init();
  await app.listen(port);
  console.log(`Beatseam server listening on :${port} (library root: ${libraryRoot}, web: ${webDist})`);
}

void bootstrap();
