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

```sh
docker run -p 8080:8080 -v ~/Music:/music/MyLibrary bpmix
```

Then open `http://localhost:8080`. Every top-level subdirectory under
`/music` inside the container becomes one library root, named after that
subdirectory — mounting `~/Music` at `/music/MyLibrary` above makes
"MyLibrary" show up in BPMix. Mount as many folders as you want, each
under its own subdirectory of `/music`:

```sh
docker run -p 8080:8080 \
  -v ~/Music:/music/MyLibrary \
  -v /mnt/nas/Music:/music/NAS \
  bpmix
```

Or with Docker Compose (see `docker-compose.yml` at the repo root):

```sh
docker compose up -d --build
```

which mounts `~/Music` the same way — edit the `volumes:` list in that
file for your own folder(s).

Building the image yourself (instead of pulling one) is documented in the
root `Dockerfile`; CI publishes a multi-arch (amd64 + arm64) image to
`ghcr.io/wentthefox/bpmix` on every push to `main`.

## Configuration

Environment variables, all optional:

| Variable              | Default   | Meaning                                                                 |
| ---------------------- | --------- | ------------------------------------------------------------------------ |
| `PORT`                | `8080`    | Port the server listens on.                                             |
| `BPMIX_LIBRARY_ROOT`   | `/music`  | Base directory scanned for library roots (its immediate subdirectories).|
| `BPMIX_WEB_DIST`       | `../web`  | Where the built web app's static files live. Only relevant if you're running `apps/server` outside the Docker image (its Dockerfile stage sets this for you). |

There's no separate per-root configuration — add or remove a folder by
adding or removing its volume mount and restarting the container.

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
