# @beatseam/server

A small backend for self-hosting Beatseam: it serves the built web app
(`apps/web/dist`) and exposes a music library that's been mounted into the
container as a Docker volume, so Beatseam can play files it could never reach
through the browser alone.

## Why this exists

The web app's default way of reading local files is the browser's
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API)
(`window.showDirectoryPicker`) — you pick a folder, the browser remembers
it, and Beatseam reads files straight out of it. That only works in Chromium
browsers, and it only ever sees folders on the device the browser itself is
running on.

Running Beatseam in a container sidesteps both limits: `apps/server` reads a
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
BEATSEAM_DB_PASSWORD=choose-something docker compose up -d --build
```

Then open `http://localhost:8080`. Every top-level subdirectory under
`/music` inside the container becomes one library root, named after that
subdirectory — the compose file mounts `~/Music` at `/music/MyLibrary`, which
makes "MyLibrary" show up in Beatseam. Mount as many folders as you want, each
under its own subdirectory of `/music` (edit the `volumes:` list for your
own folder(s)).

To run the image against a database you already have instead:

```sh
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://user:password@host:5432/beatseam \
  -v ~/Music:/music/MyLibrary:ro \
  beatseam
```

The container applies pending database migrations (`prisma migrate deploy`)
every time it starts.

Building the image yourself (instead of pulling one) is documented in the
root `Dockerfile`; CI publishes a multi-arch (amd64 + arm64) image to
`ghcr.io/wentthefox/beatseam` on every push to `main`.

## Configuration

Environment variables, all optional:

| Variable              | Default   | Meaning                                                                 |
| ---------------------- | --------- | ------------------------------------------------------------------------ |
| `PORT`                | `8080`    | Port the server listens on.                                             |
| `BEATSEAM_LIBRARY_ROOT`   | `/music`  | Base directory scanned for library roots (its immediate subdirectories).|
| `BEATSEAM_LYRICS_ROOTS`   | *(none)*  | Comma-separated subdirectory names (under `BEATSEAM_LIBRARY_ROOT`) that hold only `.lrc` files rather than playable tracks — see below. |
| `DATABASE_URL`         | *(required)* | PostgreSQL connection string, e.g. `postgresql://user:password@host:5432/beatseam`. |
| `BEATSEAM_ORIGIN`         | *(derived from the request)* | The public address of the site, e.g. `https://music.example.com` (comma-separated for several). Used for passkeys and to refuse cross-site writes. Set it. |
| `BEATSEAM_TRUST_PROXY`    | *(off)*   | How many reverse proxies to trust for the client address and protocol (`1`), or a subnet name such as `loopback`. |
| `BEATSEAM_LASTFM_API_KEY` / `BEATSEAM_LASTFM_API_SECRET` | *(Beatseam's shared Last.fm app)* | Your own Last.fm API app (last.fm/api/account/create), if you'd rather not use the shared one. Each user links their own Last.fm account from the app's settings; the server keeps the session (encrypted) and does the scrobbling. |
| `BEATSEAM_SETUP_TOKEN`    | *(generated)* | Secret required by the very first sign-up (the one that becomes the admin). If unset, the server makes a one-time token at startup and prints it in its log (`docker logs <container>`). `none` skips it, for a server on a private network. |
| `BEATSEAM_SECRET_KEY`     | *(generated)* | Key used to encrypt authenticator secrets. If unset, a random one is created once in `BEATSEAM_DATA_DIR`. |
| `BEATSEAM_DATA_DIR`       | `./data` (`/data` in the image) | Where the generated secret key lives. Keep it on a volume. |
| `BEATSEAM_DEVICE_WAIT_MS` | `25000` | How long one "wait for approval" request is held open before the app is told to ask again. |
| `BEATSEAM_AUTH_RATE_LIMIT` | `10`     | Sign-in attempts allowed per minute per address and username. |
| `BEATSEAM_SCAN_ON_START`  | `true`    | Set to `false` to not scan the library when the server starts (scans can still be started from the API, and run daily at 04:00 as a safety net). |
| `BEATSEAM_SCAN_WORKERS`   | `min(4, CPU cores)` | How many tracks are processed (tags, cover art, loudness analysis) at once. |
| `BEATSEAM_ANALYSIS_THREADS` | same as workers | Worker threads decoding and analysing audio. |
| `BEATSEAM_SCAN_MAX_ATTEMPTS` | `3`   | How many times a track is tried before it is skipped. |
| `BEATSEAM_SCAN_BACKOFF_MS` | `30000`  | Wait before the second attempt; each further attempt waits 4x longer. |
| `BEATSEAM_WEB_DIST`       | `../web`  | Where the built web app's static files live. Only relevant if you're running `apps/server` outside the Docker image (its Dockerfile stage sets this for you). |

The image runs as the unprivileged `node` user (uid 1000). A new named volume for `/data` just works; if you bind-mount
a host folder for `/data` (or reuse a volume from an older, root-running image), make it writable for uid 1000
(`chown -R 1000:1000 <folder>`). Library folders are read-only mounts and only need to be readable.

Repeated failed sign-ins are limited per account (20) and per address (100) over 15 minutes, on top of the per-minute
route throttle, so password guessing and spraying get nowhere; a locked account unlocks itself when the window passes.
Changing a password, turning off two-factor, regenerating recovery codes or removing a passkey signs out the account's other
browser sessions, and a browser session ends 90 days after it was created however actively it was used.

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

To see what is going on (admins only):

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
track, mount it as another subdirectory of `BEATSEAM_LIBRARY_ROOT` and list
its name in `BEATSEAM_LYRICS_ROOTS`:

```sh
docker run -p 8080:8080 \
  -v ~/Music:/music/MyLibrary \
  -v ~/Music/Lyrics:/music/Lyrics:ro \
  -e BEATSEAM_LYRICS_ROOTS=Lyrics \
  beatseam
```

Mount it without `:ro` if admins should be able to link, fix and re-time
lyrics from the apps (that writes the `.lrc` files, and the container user
needs write access to the folder); read-only is fine if you only want to
serve them.

Without `BEATSEAM_LYRICS_ROOTS`, that mount would show up as its own
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

## Accounts and sign-in

There is **no open registration**.

- **First run:** the first person to open the app and sign up becomes the
  admin, and must enter a setup token to do it. Unless you set
  `BEATSEAM_SETUP_TOKEN` yourself, the server generates one at startup and
  prints it in its log (it changes on every restart and only matters until
  the first account is set up); set `BEATSEAM_SETUP_TOKEN=none` to skip it on a
  private network. After that, sign-up is closed for good. (An account that never finishes
  setting up its sign-in method is held for 15 minutes and then can be
  replaced, so you can't be locked out by a half-finished setup.)
- **More people:** an admin creates each account and gets back a one-time,
  7-day link for its owner to set up their sign-in. An account with no
  sign-in method yet cannot be used. An admin can issue a replacement link
  (lost device), disable an account (ends its sessions at once) or change its
  role. There is always at least one active admin.
- **Signing in:** a passkey, or a password **plus** an authenticator-app code
  (TOTP). A password alone never signs in. Ten single-use recovery codes are
  issued when TOTP is turned on; changing credentials needs a recent sign-in.
  Native apps use their own revocable per-device tokens.
- **Protection:** sign-in attempts are rate limited per address and username,
  session cookies are HttpOnly + SameSite=Lax (+ Secure over https), writes
  from other websites are refused, and secrets (sessions, tokens, recovery
  codes) are stored only as hashes. Authenticator secrets are encrypted with
  `BEATSEAM_SECRET_KEY`, or with a key generated once into `BEATSEAM_DATA_DIR`
  (`/data` in the image — keep it on a volume, as the compose file does).

**Native apps** sign in with a device code, which works on every platform:
the app calls `POST /api/v1/auth/device/code` with a device name and shows the
returned code (and a link to `/device?code=…` on your site); the user approves
it in a browser where they are already signed in
(`POST /api/v1/auth/device/approve`); the app, meanwhile, holds a
`POST /api/v1/auth/device/wait` request open and receives a token the moment
the user approves — no polling loop. The token (`Authorization: Bearer bpd_…`)
can read the library and stream audio, but cannot administer anything or
change credentials, and stops working as soon as it is revoked
(`DELETE /api/v1/auth/devices/:id`), the account is disabled, or it has been
unused for 180 days.

Running behind a reverse proxy (recommended, for https): set `BEATSEAM_ORIGIN` to
the public address, e.g. `https://music.example.com`, and `BEATSEAM_TRUST_PROXY`
to the number of proxies in front (usually `1`) so the real client address
and protocol are used.

## Security notes

Requested paths are resolved and checked (via `fs.realpath`, so a symlink
can't be used to escape either) to stay inside their root directory before
anything is read — see `src/pathSafety.ts`.
