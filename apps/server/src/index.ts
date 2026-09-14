import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
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
// apps/web/dist is copied alongside dist/index.js in the Docker runtime image (see Dockerfile).
const webDist = process.env.BPMIX_WEB_DIST ?? path.resolve(dirname, '../web');

const app = express();

// Audio bytes (and any other file - .lrc lyrics, etc) are served by mounting
// the library directory straight into express.static rather than proxying
// each read through a hand-rolled route: static gives Range/ETag/
// If-Modified-Since support for free, and a request never has to re-scan
// discoverRoots() or re-stat anything just to answer a single byte-range
// request the browser already knows the URL for. /api/roots/:id/entries
// (routes/library.ts) still does its own manual fs walk, since it needs
// structured JSON (name/type/size/mtime) a static index can't provide.
app.use('/library', express.static(libraryRoot, { index: false }));
app.use('/api', createLibraryRouter(libraryRoot, lyricsRootIds));
app.use(express.static(webDist));
// Express 5 (path-to-regexp v8) requires a named wildcard, not bare '*'.
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});

app.listen(port, () => {
  console.log(`BPMix server listening on :${port} (library root: ${libraryRoot}, web: ${webDist})`);
});
