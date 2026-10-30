import 'reflect-metadata';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from './app.module.js';
import { createLibraryRouter } from './routes/library.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT ?? 8080);
// Every top-level subdirectory mounted under this path becomes a library root -
// e.g. `docker run -v ~/Music:/music/MyLibrary` needs no further config.
const libraryRoot = process.env.BPMIX_LIBRARY_ROOT ?? '/music';
// Comma-separated top-level subdirectory names (under libraryRoot) that hold
// only .lrc files rather than playable tracks - e.g. `-v ~/Lyrics:/music/Lyrics`
// plus `BPMIX_LYRICS_ROOTS=Lyrics`. Marked kind:'lyrics' in /api/roots so the
// client scans them as a lyrics scope instead of a (permanently empty) library.
const lyricsRootIds = new Set(
  (process.env.BPMIX_LYRICS_ROOTS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);
// apps/web/dist is copied alongside dist/main.js in the Docker runtime image (see Dockerfile).
const webDist = process.env.BPMIX_WEB_DIST ?? path.resolve(dirname, '../web');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  // Legacy file routes, kept until clients move to /api/v1. Audio bytes (and any
  // other file - .lrc lyrics, etc) are served by mounting the library directory
  // straight into express.static: Range/ETag/If-Modified-Since support for free,
  // with no per-request root discovery.
  app.use('/library', express.static(libraryRoot, { index: false }));
  app.use('/api', createLibraryRouter(libraryRoot, lyricsRootIds));

  // init() registers the Nest routes (/api/v1/*), which must happen before the
  // SPA fallback below or the wildcard would swallow them.
  await app.init();
  const http = app.getHttpAdapter().getInstance() as express.Express;
  http.use(express.static(webDist));
  // Express 5 (path-to-regexp v8) requires a named wildcard, not bare '*'.
  http.get('/*splat', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });

  await app.listen(port);
  console.log(`BPMix server listening on :${port} (library root: ${libraryRoot}, web: ${webDist})`);
}

void bootstrap();
