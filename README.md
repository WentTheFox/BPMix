# BPMix

A cross-platform DJ-style music player that crossfades between tracks
instead of just switching to the next one. It runs on Android, web, and a
self-hostable server, all sharing one playback engine.

<p align="center">
  <img src="docs/screenshots/mobile-now-playing.png" width="320" alt="Now playing screen with the current track's cover art rendered as a spinning record, up-next preview, seek bar, transport controls, and synced lyrics with the current line highlighted" />
</p>

## What it does

- **Crossfades between tracks** on an equal-power gain curve (not a linear
  fade), so the current track's normalized volume ramps down while the
  next one ramps up, timed to a configurable crossfade length.
- **Renders the current and next track as spinning vinyl records**
  (`CrossfadeArt`), with a tonearm needle that tracks real playback
  progress, and spin speed/rotation tied to how audible each track
  actually is right now.
- **Reads real ID3 metadata** (title, artist(s), album, cover art) from
  audio files, scanned asynchronously in the background so the library
  is usable immediately and fills in as tags are read.
- **Playlist-first, not a folder browser.** BPMix is built around
  `.m3u8`/`.m3u` playlists, not "browse and play any audio file in a
  folder" like a traditional music player. Scanning a folder only picks
  up files that some playlist in it actually references. A stray
  `.mp3` sitting in the folder with no playlist entry pointing at it
  won't show up in the library at all. This is deliberate: playlists are
  what you curate, and BPMix has no view for "everything in this folder"
  outside of that.
- **Shuffle, loop, and playlist persistence** via a shared
  `PlaylistPlayer`. Playback position, the current playlist/track, loop
  mode, and shuffle order all survive an app restart.
- **Lyrics.** Auto-matches `.lrc`/plaintext lyrics files from a separate
  lyrics folder to library tracks by filename, shows them synced (or
  static) on the Now Playing screen, and lets you manually (re)assign a
  lyrics file per track from a searchable picker when auto-matching picks
  the wrong one or finds nothing.
- **Settings screen**: theme (Light/Flux/Dark/AMOLED), accent color,
  volume normalization, and a configurable crossfade duration (1-20s).
- **System media integration on Android.** Lock-screen/notification-shade
  play/pause/next/previous controls and title/artist/art/progress
  reporting via the OS media session, not just an in-app transport.
- **In-app notification center** (the bell icon) surfaces background
  library/lyrics scan progress and non-fatal errors (a bad file, a
  permission issue) without interrupting playback.
- **Runs the same UI on Android and web** via React Native + React Native
  Web, sharing components/business logic in `packages/ui`/`packages/core`
  rather than duplicating it per platform. Windows support (react-native-
  windows) is in progress.
- **Self-hostable.** `apps/server` serves the built web app plus a music
  library mounted into a Docker container, so any browser (not just
  Chromium, which is all the browser-only build supports via the File
  System Access API) can browse and play a library that lives elsewhere
  entirely (a NAS, a home server, ...).

## Project layout

This is a pnpm workspace monorepo:

| Path | What it is |
| --- | --- |
| `apps/mobile` | The React Native app (Android; Windows support in progress). |
| `apps/web` | The same UI running on the web via `react-native-web` + Vite. |
| `apps/server` | Optional self-hosting backend. Serves `apps/web`'s build and exposes a Docker-mounted library over HTTP. See `apps/server/README.md`. |
| `packages/core` | Platform-agnostic playback/analysis/library logic: `PlaylistPlayer`/`TrackPlayer`, BPM/loudness/silence analysis, the crossfade gain curve, library scanning, metadata. No React, no platform APIs. |
| `packages/ui` | Shared React Native components used by both apps (`CrossfadeArt`, `TrackList`, `SeekBar`, icons, etc.), including platform-split files (e.g. `useSpin.ts` vs `useSpin.web.ts`) where mobile and web genuinely need different implementations. |

## Getting started

Requires Node 20+ and pnpm.

```sh
pnpm install

# Android (needs Metro + a device/emulator, same as any RN app)
pnpm android

# Web
pnpm web

# Type-check and test everything
pnpm typecheck
pnpm test
```

Self-hosting via Docker is documented separately in
[`apps/server/README.md`](apps/server/README.md).

## Status

BPMix is under active development. See `CLAUDE.md`'s TODOs section for
what's planned next (an LRC sync editor, automatic translated-lyrics
generation, generating a playlist directly from a folder, Windows
support, and more). Everything described above (crossfade, vinyl-art
rendering, ID3 metadata, lyrics matching, settings, playback/playlist
persistence, Android media-session integration) is implemented and
working today. The more ambitious just-in-time BPM-matching crossfade
engine (continuous beat detection instead of the current fixed-length
crossfade) is still in progress.

## License

MIT. See [`LICENSE`](LICENSE).
