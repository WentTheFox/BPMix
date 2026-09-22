import type { LastFmCredentials, LibraryStore, ScrobbleEntry, ScrobbleTrackInfo } from '@bpmix/core';
import { appendToScrobbleQueue, decodeScrobbleQueue, encodeScrobbleQueue, LastFmError, scrobbleBatch, ScrobbleTracker, updateNowPlaying } from '@bpmix/core';
import { useEffect, useRef } from 'react';
import type { AppSettings } from '../settings/types';

/** Settings-store key for the offline retry queue (see ScrobbleTracker/scrobbleQueue) - a plain JSON array of ScrobbleEntry, capped at MAX_QUEUED_SCROBBLES. */
const SCROBBLE_QUEUE_SETTING_KEY = 'scrobble.pendingQueue';

/**
 * Wires playback to Last.fm's now-playing/scrobble calls whenever the user
 * is connected (settings.lastFmSessionKey set) - a no-op hook entirely
 * otherwise. Lives in packages/ui (not per-platform, unlike
 * mediaSessionNotification) since scrobbling is just `fetch` calls, the
 * same on web/Android/Windows; App.tsx on each platform calls this right
 * alongside its own useMediaSessionNotification call, with the same
 * playback snapshot.
 *
 * A scrobble that fails (offline, Last.fm down) is queued to
 * `libraryStore`'s generic settings store rather than dropped - the queue
 * is flushed (as one batched track.scrobble call) the next time a scrobble
 * succeeds, and once more on mount to catch a backlog left over from the
 * last session.
 */
export function useLastFmScrobbling(libraryStore: LibraryStore, settings: AppSettings, info: ScrobbleTrackInfo | null, isPlaying: boolean, positionSeconds: number): void {
  const credentials: LastFmCredentials | null =
    settings.lastFmSessionKey && settings.lastFmApiKey && settings.lastFmApiSecret
      ? { apiKey: settings.lastFmApiKey, apiSecret: settings.lastFmApiSecret }
      : null;
  const sessionKey = settings.lastFmSessionKey;

  // Read through refs inside the tracker's callbacks/flush logic below,
  // rather than recreating the ScrobbleTracker whenever credentials change
  // - see MediaSessionNotificationInfo's callbacksRef for the identical
  // reasoning (the tracker's own play-instance state must survive a
  // credentials change mid-track, e.g. connecting to Last.fm while
  // something is already playing).
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  const flushQueue = useRef(async () => {
    const creds = credentialsRef.current;
    const sk = sessionKeyRef.current;
    if (!creds || !sk) return;
    const queue = decodeScrobbleQueue(await libraryStore.getSetting(SCROBBLE_QUEUE_SETTING_KEY));
    if (queue.length === 0) return;
    try {
      // scrobbleBatch caps at 50 - only the oldest 50 are flushed per
      // attempt, which is fine: a successful flush clears exactly those,
      // and the next one (next scrobble, or next launch) picks up the rest.
      await scrobbleBatch(creds, sk, queue.slice(0, 50));
      await libraryStore.putSetting(SCROBBLE_QUEUE_SETTING_KEY, encodeScrobbleQueue(queue.slice(50)));
    } catch {
      // Still offline/still failing - leave the queue as-is for next time.
    }
  });

  const enqueueFailedScrobble = useRef(async (entry: ScrobbleEntry) => {
    const queue = decodeScrobbleQueue(await libraryStore.getSetting(SCROBBLE_QUEUE_SETTING_KEY));
    await libraryStore.putSetting(SCROBBLE_QUEUE_SETTING_KEY, encodeScrobbleQueue(appendToScrobbleQueue(queue, entry)));
  });

  useEffect(() => {
    void flushQueue.current();
    // Runs once on mount only - a deliberate one-shot "catch up on
    // whatever didn't make it out last session" pass, not tied to any
    // particular dependency. flushQueue is a ref, so it's exempt from
    // exhaustive-deps in the first place - nothing to disable here.
  }, []);

  const trackerRef = useRef<ScrobbleTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new ScrobbleTracker({
      onNowPlaying: (track) => {
        const creds = credentialsRef.current;
        const sk = sessionKeyRef.current;
        if (!creds || !sk) return;
        void updateNowPlaying(creds, sk, { artist: track.artist, track: track.title, album: track.album, durationSeconds: track.durationSeconds }).catch(
          () => {
            // now-playing status is best-effort/ephemeral (Last.fm has no
            // concept of retrying it later) - only the eventual scrobble
            // itself is worth queuing for retry.
          },
        );
      },
      onScrobble: (track, startedAtUnixSeconds) => {
        const creds = credentialsRef.current;
        const sk = sessionKeyRef.current;
        const entry: ScrobbleEntry = {
          artist: track.artist,
          track: track.title,
          album: track.album,
          durationSeconds: track.durationSeconds,
          timestamp: startedAtUnixSeconds,
        };
        if (!creds || !sk) {
          void enqueueFailedScrobble.current(entry);
          return;
        }
        void scrobbleBatch(creds, sk, [entry])
          .then(() => flushQueue.current())
          .catch((err) => {
            if (err instanceof LastFmError && err.code != null) {
              // A real API-level rejection (bad session, malformed request)
              // rather than a transient network failure - retrying it
              // later would just fail the same way again.
              return;
            }
            void enqueueFailedScrobble.current(entry);
          });
      },
    });
  }

  useEffect(() => {
    trackerRef.current!.update(info, isPlaying, positionSeconds);
  });
}
