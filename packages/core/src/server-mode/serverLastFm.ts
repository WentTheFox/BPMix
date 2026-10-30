import { ApiError, type ApiClient } from '@bpmix/api';
import { LastFmError } from '../scrobble/lastfm';
import type { ScrobbleSink } from '../scrobble/scrobbleSink';

/** Failed scrobbles for the server's Last.fm link wait here; cleared on sign-out (they belong to that account). */
export const SERVER_SCROBBLE_QUEUE_KEY = 'serverMode.scrobbleQueue';

/** Scrobbles through the server, which holds the user's Last.fm link (see apps/server's LastFmService). */
export function createServerScrobbleSink(getApi: () => ApiClient | null): ScrobbleSink {
  const api = () => {
    const client = getApi();
    if (!client) throw new Error('Not signed in to a server');
    return client;
  };
  return {
    queueKey: SERVER_SCROBBLE_QUEUE_KEY,
    async nowPlaying(track) {
      await api().lastFmNowPlaying({ artist: track.artist, track: track.title, album: track.album, durationSeconds: track.durationSeconds });
    },
    async scrobble(entries) {
      try {
        await api().lastFmScrobble(entries);
      } catch (err) {
        // Last.fm itself refused them: final. Anything else (server or Last.fm unreachable, not connected yet) is worth retrying.
        if (err instanceof ApiError && err.status === 422) throw new LastFmError(err.message, 0);
        throw err;
      }
    },
  };
}
