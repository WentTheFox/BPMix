import { useEffect, useRef } from 'react';
import { AudioManager, PlaybackNotificationManager } from 'react-native-audio-api';

export interface MediaSessionNotificationInfo {
  title: string;
  artist: string | null;
  album: string | null;
  /** A `file://`/`data:`/http(s) URI - anything `<Image source={{uri}}/>` already accepts elsewhere in the app. */
  artworkUri: string | null;
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;
}

export interface MediaSessionNotificationCallbacks {
  /** Fired for both the notification's play and pause taps - togglePause()-style callers already resume/pause based on the actual current status, and the OS only shows whichever of the two makes sense for that status anyway. */
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeekTo: (positionSeconds: number) => void;
}

/**
 * Wires playback to Android's lock-screen/notification-shade media controls
 * (MediaSession) via react-native-audio-api's PlaybackNotificationManager -
 * already bundled with the audio engine dependency this app uses for
 * playback itself, so no extra native module was needed, just
 * AndroidManifest.xml's permission/service declarations (see the comment
 * there) plus this JS glue.
 *
 * Deliberately does NOT re-push the notification on every position tick
 * (BPMix's own ~200ms poll) - the underlying PlaybackStateCompat carries a
 * position+speed pair that Android itself interpolates from between
 * updates (the same mechanism every proper MediaSession-based player
 * relies on for a smoothly-advancing lock-screen seek bar), so this only
 * needs to (and does) re-anchor on track/state changes. A known, accepted
 * gap: a manual seek via BPMix's own in-app seek bar (as opposed to the
 * notification's own seek bar, which calls onSeekTo below and IS covered)
 * won't immediately re-anchor the lock-screen's displayed position until
 * the next track/play-pause change - rare enough (seeking while actually
 * looking at the lock screen at that exact moment) not to be worth a
 * dedicated "did a discontinuity just happen" signal for a first pass.
 */
export function useMediaSessionNotification(info: MediaSessionNotificationInfo | null, callbacks: MediaSessionNotificationCallbacks): void {
  // Registered once below - reading through a ref rather than
  // re-subscribing on every change keeps that effect's own lifecycle
  // (and the native listener registration it drives) independent of
  // however often the callbacks' own identities change.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    // Best-effort: MediaSessionManager.kt already checks/requests this
    // itself before actually posting a notification (see
    // AndroidManifest.xml's comment), so a denial here just means the
    // first real show() call below prompts for it instead.
    void AudioManager.requestNotificationPermissions();

    const subscriptions = [
      PlaybackNotificationManager.addEventListener('playbackNotificationPlay', () => callbacksRef.current.onPlayPause()),
      PlaybackNotificationManager.addEventListener('playbackNotificationPause', () => callbacksRef.current.onPlayPause()),
      PlaybackNotificationManager.addEventListener('playbackNotificationNextTrack', () => callbacksRef.current.onNext()),
      PlaybackNotificationManager.addEventListener('playbackNotificationPreviousTrack', () => callbacksRef.current.onPrevious()),
      PlaybackNotificationManager.addEventListener('playbackNotificationSeekTo', (event) => callbacksRef.current.onSeekTo(event.value)),
    ];
    return () => {
      subscriptions.forEach((subscription) => subscription.remove());
      void PlaybackNotificationManager.hide();
    };
    // Registered once for the lifetime of the app - see callbacksRef's doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!info) {
      void PlaybackNotificationManager.hide();
      return;
    }
    void (async () => {
      await PlaybackNotificationManager.show({
        title: info.title,
        artist: info.artist ?? undefined,
        album: info.album ?? undefined,
        artwork: info.artworkUri ? { uri: info.artworkUri } : undefined,
        duration: info.durationSeconds,
        elapsedTime: info.positionSeconds,
        state: info.isPlaying ? 'playing' : 'paused',
      });
      // show() alone doesn't enable any transport action - the underlying
      // PlaybackStateCompat's `actions` bitmask starts at 0 (confirmed
      // on-device via `adb shell dumpsys media_session`: actions=0), which
      // is why Android silently refuses to route ANY command to this
      // session at all, including a real hardware/Bluetooth media-button
      // press - each control has to be turned on explicitly. Repeating
      // this on every show() call is harmless (enableControl ORs the flag
      // in) and guards against `controls` ever having been reset.
      await Promise.all([
        PlaybackNotificationManager.enableControl('play', true),
        PlaybackNotificationManager.enableControl('pause', true),
        PlaybackNotificationManager.enableControl('nextTrack', true),
        PlaybackNotificationManager.enableControl('previousTrack', true),
        PlaybackNotificationManager.enableControl('seekTo', true),
      ]);
    })();
    // info.positionSeconds is deliberately read here without being listed -
    // see this function's own doc for why re-anchoring only on these
    // identity/state changes (not on every position tick) is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.title, info?.artist, info?.album, info?.artworkUri, info?.durationSeconds, info?.isPlaying]);
}
