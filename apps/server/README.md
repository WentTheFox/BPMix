# @bpmix/server

A small backend for self-hosting BPMix: it serves the built web app
(`apps/web/dist`) and exposes a music library that's been mounted into the
container as a Docker volume, so BPMix can play files it could never reach
through the browser alone.

## Why this exists

The web app's default way of reading local files is the browser's
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
(`window.showDirectoryPicker`) — you pick a folder, the browser remembers
it, and BPMix reads files straight out of it. That only works in Chromium
browsers, and it only ever sees folders on the device the browser itself is
running on.

Running BPMix in a container sidesteps both limits: `apps/server` reads a
folder that's been bind-mounted or volume-mounted into the container and
serves it over a small HTTP API, so any browser — Chromium, Firefox,
Safari, mobile — can browse and play it, and the library can live somewhere
other than the device you're listening from (a NAS, a home server, etc).

Both mechanisms can be used at once: `apps/web` merges browser-picked
folders with whatever `apps/server` exposes (see "How the web app finds
it" below). Nothing needs to be configured to enable this — the composite
file-access adapter just tries the server API, and behaves exactly like
the plain browser-only build if there isn't one to talk to (e.g. a static
deploy with no backend, such as Cloudflare Pages).

## Quick start

The server keeps its scanned library in PostgreSQL, so it needs a database.
Docker Compose (see `docker-compose.yml` at the repo root) sets one up for you:

```sh
BPMIX_DB_PASSWORD=choose-something docker compose up -d --build
```

Then open `http://localhost:8080`. Every top-level subdirectory under
`/music` inside the container becomes one library root, named after that
subdirectory — the compose file mounts `~/Music` at `/music/MyLibrary`, which
makes "MyLibrary" show up in BPMix. Mount as many folders as you want, each
under its own subdirectory of `/music` (edit the `volumes:` list for your
own folder(s)).

To run the image against a database you already have instead:

```sh
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://user:password@host:5432/bpmix \
  -v ~/Music:/music/MyLibrary:ro \
  bpmix
```

The container applies pending database migrations (`prisma migrate deploy`)
every time it starts.

Building the image yourself (instead of pulling one) is documented in the
root `Dockerfile`; CI publishes a multi-arch (amd64 + arm64) image to
`ghcr.io/wentthefox/bpmix` on every push to `main`.

## Configuration

Environment variables, all optional:

| Variable              | Default   | Meaning                                                                 |
| ---------------------- | --------- | ------------------------------------------------------------------------ |
| `PORT`                | `8080`    | Port the server listens on.                                             |
| `BPMIX_LIBRARY_ROOT`   | `/music`  | Base directory scanned for library roots (its immediate subdirectories).|
| `BPMIX_LYRICS_ROOTS`   | *(none)*  | Comma-separated subdirectory names (under `BPMIX_LIBRARY_ROOT`) that hold only `.lrc` files rather than playable tracks — see below. |
| `DATABASE_URL`         | *(required)* | PostgreSQL connection string, e.g. `postgresql://user:password@host:5432/bpmix`. |
| `BPMIX_SCAN_ON_START`  | `true`    | Set to `false` to not scan the library when the server starts (scans can still be started from the API, and run daily at 04:00 as a safety net). |
| `BPMIX_SCAN_WORKERS`   | `min(4, CPU cores)` | How many tracks are processed (tags, cover art, loudness analysis) at once. |
| `BPMIX_ANALYSIS_THREADS` | same as workers | Worker threads decoding and analysing audio. |
| `BPMIX_SCAN_MAX_ATTEMPTS` | `3`   | How many times a track is tried before it is skipped. |
| `BPMIX_SCAN_BACKOFF_MS` | `30000`  | Wait before the second attempt; each further attempt waits 4x longer. |
| `BPMIX_WEB_DIST`       | `../web`  | Where the built web app's static files live. Only relevant if you're running `apps/server` outside the Docker image (its Dockerfile stage sets this for you). |

There's no separate per-root configuration — add or remove a folder by
adding or removing its volume mount and restarting the container.

### How scanning works

A scan walks every library root and registers each audio file as a track,
then queues one job per new or changed track. A pool of workers (the number
above) takes jobs off that queue — a track is only ever given to one worker —
and for each reads its tags and cover art, finds its duration and a SHA-256
of the file, and measures its loudness (via `ffmpeg`). Lyrics are matched
across the library once the queue has settled.

A track that fails is retried with a growing delay. After the last attempt it
is marked **skipped** and later scans leave it alone, so one unreadable file
can't make every scan slow and noisy. It gets a fresh set of attempts when the
file changes (size or modified time), when the app's tag-reading or analysis
code is updated, or when you ask for it. If the server stops while a track is
being processed, another worker picks the job up when its lease runs out.

To see what is going on (these endpoints are not yet protected — authentication
is still to come):

| Request | Shows |
| --- | --- |
| `GET /api/v1/scan` | Whether a scan is running, the last scan's summary, queue counts (pending, retrying, running, done, skipped) and worker stats. |
| `GET /api/v1/scan/jobs?state=SKIPPED` | The tracks in a queue state (default `SKIPPED`), with their last error and the stage it failed in. |
| `GET /api/v1/scan/failures` | Every failed attempt, newest first (`?trackId=` for one track). Old entries are deleted after 30 days. |
| `POST /api/v1/scan` | Starts a scan (or joins the running one). |
| `POST /api/v1/scan/retry` | Gives skipped tracks (`?trackId=` for one) a fresh set of attempts. |

The server also logs each failed attempt, with the track and the reason.

### Mounting a separate lyrics folder

If your `.lrc` files live in their own folder rather than next to each
track, mount it as another subdirectory of `BPMIX_LIBRARY_ROOT` and list
its name in `BPMIX_LYRICS_ROOTS`:

```sh
docker run -p 8080:8080 \
  -v ~/Music:/music/MyLibrary \
  -v ~/Music/Lyrics:/music/Lyrics:ro \
  -e BPMIX_LYRICS_ROOTS=Lyrics \
  bpmix
```

Without `BPMIX_LYRICS_ROOTS`, that mount would show up as its own
permanently-empty "Lyrics" library. With it, the client recognizes it as a
lyrics-only scope and matches its `.lrc` files against tracks in every
other root automatically — no picking a folder from the UI needed (the
server grants roots via volume mounts, not a user gesture, so there's
nothing for a folder picker to do here).

## How the web app finds it

`apps/web/src/adapters/fileAccess.composite.ts` wraps two `FileAccess`
implementations behind one interface:

- `fileAccess.ts` — the browser picker, unchanged from before this existed.
- `fileAccess.server.ts` — lists directories via this server's
  `/api/roots` and `/api/roots/:rootId/entries` endpoints (structured
  JSON, since a browser needs name/type/size/mtime to build the library
  UI), and reads file bytes/text directly from `/library/:rootId/...`,
  a plain `express.static` mount over the library directory - no
  proxying route in between, so Range requests, conditional GETs, and
  MIME types all come from Express's static file serving instead of
  a hand-rolled equivalent.

On first use the composite adapter probes `/api/roots` once. If it
succeeds, server-exposed roots show up in the library list alongside any
browser-picked ones — automatically, with no user action, since the
operator already granted access by mounting the volume. If the probe
fails (no `apps/server` behind this deployment), the composite adapter
just behaves like the plain browser adapter from then on.

One consequence: server-exposed roots can't be "revoked" from the UI the
way a browser-picked folder can — there's nothing client-side to revoke,
since the grant lives in how the container was started. Removing the
volume mount and restarting the container is the equivalent.

## Security notes

There's no authentication in front of this API — it's meant for a
self-hosted, single-user (or trusted-LAN) deployment. If you're exposing
it beyond your own network, put it behind a reverse proxy that adds auth,
same as you would for any other self-hosted app with no login screen of
its own.

Requested paths are resolved and checked (via `fs.realpath`, so a symlink
can't be used to escape either) to stay inside their root directory before
anything is read — see `src/pathSafety.ts`.
