import { scrobbleBatch, updateNowPlaying, type LastFmCredentials, type ScrobbleEntry } from './lastfm';

/**
 * Where scrobbles and now-playing updates go once the tracker decides to send them: Last.fm directly (the
 * local-folder app, which holds its own session) or BPMix's server (which holds the user's link).
 * `scrobble` rejects with a LastFmError carrying a code when the service refused them for good (retrying
 * would fail the same way) and with any other error when trying again later could work.
 */
export interface ScrobbleSink {
  /** Where this sink's failed scrobbles wait for a retry; separate per sink so one account's plays never go to another's. */
  readonly queueKey: string;
  nowPlaying(track: { artist: string; title: string; album: string | null; durationSeconds: number | null }): Promise<void>;
  scrobble(entries: ScrobbleEntry[]): Promise<void>;
}

export const LOCAL_SCROBBLE_QUEUE_KEY = 'scrobble.pendingQueue';

/** Straight to Last.fm with this device's own session. */
export function createLocalScrobbleSink(credentials: LastFmCredentials, sessionKey: string): ScrobbleSink {
  return {
    queueKey: LOCAL_SCROBBLE_QUEUE_KEY,
    nowPlaying: (track) => updateNowPlaying(credentials, sessionKey, { artist: track.artist, track: track.title, album: track.album, durationSeconds: track.durationSeconds }),
    scrobble: (entries) => scrobbleBatch(credentials, sessionKey, entries),
  };
}
