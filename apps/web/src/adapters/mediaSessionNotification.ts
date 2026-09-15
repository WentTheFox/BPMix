import { useEffect, useRef } from 'react';

export interface MediaSessionNotificationInfo {
  title: string;
  artist: string | null;
  album: string | null;
  /** A `blob:`/`data:`/http(s) URL - anything `<img src>` already accepts elsewhere in the app. */
  artworkUri: string | null;
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;
}

export interface MediaSessionNotificationCallbacks {
  /** Fired for both the OS/browser UI's play and pause controls - togglePause()-style callers already resume/pause based on the actual current status. */
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeekTo: (positionSeconds: number) => void;
}

/**
 * Wires playback to the browser's `navigator.mediaSession` - the web
 * equivalent of mediaSessionNotification.android.ts's lock-screen/
 * notification-shade controls, surfaced instead via the OS media-key
 * overlay, browser tab/media-hub UI, and hardware media keys/Bluetooth
 * controls. No native module or manifest declaration needed - this is a
 * plain browser API available in every target browser (see MDN's Media
 * Session API baseline support).
 */
export function useMediaSessionNotification(info: MediaSessionNotificationInfo | null, callbacks: MediaSessionNotificationCallbacks): void {
  // Registered once below - reading through a ref rather than
  // re-subscribing on every change keeps the action-handler registration
  // independent of however often the callbacks' own identities change.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => callbacksRef.current.onPlayPause());
    navigator.mediaSession.setActionHandler('pause', () => callbacksRef.current.onPlayPause());
    navigator.mediaSession.setActionHandler('nexttrack', () => callbacksRef.current.onNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => callbacksRef.current.onPrevious());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) callbacksRef.current.onSeekTo(details.seekTime);
    });
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('seekto', null);
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    };
    // Registered once for the page's lifetime - see callbacksRef's doc.
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!info) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: info.title,
      artist: info.artist ?? undefined,
      album: info.album ?? undefined,
      artwork: info.artworkUri ? [{ src: info.artworkUri }] : undefined,
    });
    navigator.mediaSession.playbackState = info.isPlaying ? 'playing' : 'paused';
    // setPositionState throws if duration isn't a positive finite number
    // (e.g. a track whose metadata hasn't resolved yet) - browsers surface
    // that as an uncaught DOMException rather than silently ignoring it.
    if (Number.isFinite(info.durationSeconds) && info.durationSeconds > 0) {
      navigator.mediaSession.setPositionState({
        duration: info.durationSeconds,
        position: Math.min(info.positionSeconds, info.durationSeconds),
        playbackRate: 1,
      });
    }
    // info.positionSeconds is deliberately read here (unlike the Android
    // version, which only re-anchors on identity/state changes) - the
    // browser has no separate mechanism to interpolate a smoothly-advancing
    // position on its own, so setPositionState needs a fresh position each
    // time to keep the OS/browser scrubber in sync with BPMix's own
    // ~200ms poll.
    //
    // Deliberately depends on `info`'s individual fields, not `info`
    // itself - the caller (App.tsx) passes a fresh object literal every
    // render, so depending on the object's identity would rerun this
    // effect on every render regardless of whether anything it actually
    // reads changed, not just the ~200ms poll ticks that genuinely move
    // positionSeconds. exhaustive-deps can't see that every field it reads
    // (including the `!info` null check) is already covered field-by-field
    // here, hence the disable below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.title, info?.artist, info?.album, info?.artworkUri, info?.durationSeconds, info?.isPlaying, info?.positionSeconds]);
}
