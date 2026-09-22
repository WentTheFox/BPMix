/**
 * Discord Rich Presence - the same SET_ACTIVITY JSON-frame protocol Discord
 * has used for its desktop named-pipe IPC for years, now also reachable on
 * Android via a bound-service Binder connection to the real Discord app
 * (see apps/mobile/android/.../discordrpc/DiscordRpcModule.kt) - this frame
 * builder is deliberately transport-agnostic so a future Windows
 * implementation (a native module speaking the same protocol over a named
 * pipe) can reuse it unchanged.
 *
 * No client secret or per-user auth involved - unlike Last.fm's api_key,
 * a Discord application id is not confidential (it's the same id already
 * public in that app's invite links/OAuth redirects), so BPMix bakes in
 * its own by default the same way it does for Last.fm - see
 * DEFAULT_DISCORD_APPLICATION_ID.
 */

/** BPMix's own registered Discord application - see this file's own doc for why sharing one publicly-known id across installs is fine (unlike Last.fm's secret, nothing here is confidential). */
export const DEFAULT_DISCORD_APPLICATION_ID = '1551930093159587941';

export interface DiscordPresenceBridge {
  /** Binds to Discord's RPC service and performs the handshake. Resolves false (not a rejection) if Discord isn't installed/reachable or refuses the handshake - a missing Discord app is an expected, common case, not an error worth surfacing to the user. */
  connect(applicationId: string): Promise<boolean>;
  /** Sends a raw JSON RPC frame (see buildSetActivityFrame). Resolves false if there's no active connection - again expected/silent, not an error. */
  sendFrame(frame: string): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface DiscordNowPlayingInfo {
  title: string;
  artist: string;
  /** When this play instance started, so Discord can show a live-counting elapsed time rather than a static string. */
  startedAtUnixMs: number;
  /**
   * Only usable if it's a real http(s) URL Discord's own servers can
   * fetch - buildSetActivityFrame ignores anything else (see there),
   * because local cover art is always a `data:`/`content://`/`blob:` URI
   * (see useCoverArt), and confirmed live that a `data:` URI is silently
   * rejected by Discord (renders as a blank circle, not the image, not
   * even the "unknown asset key" placeholder - it's a different failure
   * mode than an unrecognized asset key string). Real per-track art here
   * needs a publicly-reachable self-hosted BPMix server URL, which isn't
   * wired up yet - always null until that exists.
   */
  albumArtUrl: string | null;
}

let nonceCounter = 0;

/**
 * Builds a SET_ACTIVITY frame - `info: null` clears the activity (shows
 * nothing in the user's Discord status) rather than leaving a stale "still
 * playing" status up after playback stops.
 *
 * type: 2 ("Listening to BPMix, details/state below") - RPC clients are
 * restricted to Playing(0)/Listening(2)/Watching(3)/Competing(5) per
 * Discord's own RPC docs, and Listening is the only one of those that
 * actually fits a music player.
 */
export function buildSetActivityFrame(info: DiscordNowPlayingInfo | null): string {
  nonceCounter += 1;
  // See albumArtUrl's own doc - only a real http(s) URL is usable; anything
  // else (data:/content:///blob:, which is what local cover art always is
  // today) is treated the same as having no art at all, since Discord can't
  // fetch it and silently shows a blank circle rather than falling back on
  // its own.
  const usableAlbumArtUrl = info?.albumArtUrl?.startsWith('http') ? info.albumArtUrl : null;
  return JSON.stringify({
    cmd: 'SET_ACTIVITY',
    nonce: `bpmix-${Date.now()}-${nonceCounter}`,
    args: {
      pid: 0,
      activity: info
        ? {
            type: 2,
            // Without this, Discord shows the generic "Listening to Game"
            // instead of "Listening to BPMix" - confirmed live (it silently
            // falls back to that placeholder rather than erroring).
            name: 'BPMix',
            details: info.title,
            state: info.artist,
            timestamps: { start: info.startedAtUnixMs },
            // No `assets` at all when there's no real art, rather than
            // referencing a Rich Presence Assets key (e.g. an uploaded app
            // icon asset) - confirmed live that Discord's own asset-key
            // resolution can 404 on a freshly-uploaded, correctly-keyed,
            // correctly-referenced asset with no clear fix beyond "wait and
            // hope", whereas omitting `assets` entirely reliably falls back
            // to the application's own registered icon (verified via the
            // public `GET /applications/{id}/rpc` endpoint + its
            // `app-icons` CDN URL both resolving) with zero extra setup.
            assets: usableAlbumArtUrl ? { large_image: usableAlbumArtUrl, large_text: info.title } : undefined,
          }
        : null,
    },
  });
}
