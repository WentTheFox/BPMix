import type { LibraryStore, ScrobbleEntry, ScrobbleSink, ScrobbleTrackInfo } from '@beatseam/core';
import { appendToScrobbleQueue, decodeScrobbleQueue, encodeScrobbleQueue, LastFmError, ScrobbleTracker } from '@beatseam/core';
import { useEffect, useRef } from 'react';

/**
 * Wires playback to Last.fm's now-playing/scrobble calls through `sink` (Last.fm directly with this
 * device's session, or the server's link - see ScrobbleSink) - a no-op hook entirely when there's no sink,
 * i.e. when nothing is connected. Lives in packages/ui (not per-platform, unlike
 * mediaSessionNotification) since scrobbling is just `fetch` calls, the same on web/Android/Windows;
 * App.tsx on each platform calls this right alongside its own useMediaSessionNotification call, with the
 * same playback snapshot.
 *
 * A scrobble that fails (offline, Last.fm down) is queued to `libraryStore`'s generic settings store
 * rather than dropped - the queue is flushed (as one batched call) the next time a scrobble succeeds, and
 * once more on mount and whenever the sink changes (connecting, signing in) to catch a backlog.
 */
export function useLastFmScrobbling(
  libraryStore: LibraryStore,
  sink: ScrobbleSink | null,
  info: ScrobbleTrackInfo | null,
  isPlaying: boolean,
  positionSeconds: number,
  /** Where plays made while nothing is connected wait, to be sent once something is (the local-folder app backfills this way). Omitted: such plays aren't kept. */
  queueKeyWhenDisconnected?: string,
): void {
  // Read through a ref inside the tracker's callbacks/flush logic below, rather than recreating the
  // ScrobbleTracker whenever the sink changes - see MediaSessionNotificationInfo's callbacksRef for the
  // identical reasoning (the tracker's own play-instance state must survive a connection change mid-track,
  // e.g. connecting to Last.fm while something is already playing).
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  const flushQueue = useRef(async () => {
    const current = sinkRef.current;
    if (!current) return;
    const queue = decodeScrobbleQueue(await libraryStore.getSetting(current.queueKey));
    if (queue.length === 0) return;
    try {
      // Last.fm takes 50 per call - only the oldest 50 are flushed per attempt, which is fine: a
      // successful flush clears exactly those, and the next one (next scrobble, or next launch) picks up the rest.
      await current.scrobble(queue.slice(0, 50));
      await libraryStore.putSetting(current.queueKey, encodeScrobbleQueue(queue.slice(50)));
    } catch (err) {
      // Refused for good: retrying the same entries would only fail again and block the rest behind them.
      if (err instanceof LastFmError && err.code != null) await libraryStore.putSetting(current.queueKey, encodeScrobbleQueue(queue.slice(50)));
      // Otherwise still offline/failing - leave the queue as-is for next time.
    }
  });

  const disconnectedKeyRef = useRef(queueKeyWhenDisconnected);
  disconnectedKeyRef.current = queueKeyWhenDisconnected;
  const enqueueFailedScrobble = useRef(async (entry: ScrobbleEntry) => {
    const key = sinkRef.current?.queueKey ?? disconnectedKeyRef.current;
    if (!key) return;
    const queue = decodeScrobbleQueue(await libraryStore.getSetting(key));
    await libraryStore.putSetting(key, encodeScrobbleQueue(appendToScrobbleQueue(queue, entry)));
  });

  const sinkKey = sink?.queueKey ?? null;
  useEffect(() => {
    void flushQueue.current();
    // Once on mount and again whenever the destination changes: a deliberate "catch up on whatever didn't
    // make it out" pass. flushQueue is a ref, so it's exempt from exhaustive-deps.
  }, [sinkKey]);

  const trackerRef = useRef<ScrobbleTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new ScrobbleTracker({
      onNowPlaying: (track) => {
        // now-playing status is best-effort/ephemeral (Last.fm has no concept of retrying it later) -
        // only the eventual scrobble itself is worth queuing for retry.
        void sinkRef.current?.nowPlaying({ artist: track.artist, title: track.title, album: track.album, durationSeconds: track.durationSeconds }).catch(() => undefined);
      },
      onScrobble: (track, startedAtUnixSeconds) => {
        const entry: ScrobbleEntry = {
          artist: track.artist,
          track: track.title,
          album: track.album,
          durationSeconds: track.durationSeconds,
          timestamp: startedAtUnixSeconds,
        };
        const current = sinkRef.current;
        if (!current) {
          void enqueueFailedScrobble.current(entry);
          return;
        }
        void current
          .scrobble([entry])
          .then(() => flushQueue.current())
          .catch((err) => {
            if (err instanceof LastFmError && err.code != null) {
              // A real rejection (bad session, malformed request) rather than a transient failure -
              // retrying it later would just fail the same way again.
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
