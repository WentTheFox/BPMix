import type { DiscordNowPlayingInfo, DiscordPresenceBridge } from '@bpmix/core';
import { buildSetActivityFrame } from '@bpmix/core';
import { useEffect, useRef, useState } from 'react';

export interface DiscordPresenceTrackInfo {
  /** Identity, not display text - used only to detect a genuinely new play instance (see trackStartRef below), the same loop-replay problem ScrobbleTracker (packages/core) solves the same way. */
  fileId: string;
  title: string;
  artist: string;
  /** Same resized data: URI useCoverArt/MediaSessionNotificationInfo.artworkUri already use - see DiscordNowPlayingInfo.albumArtUrl's doc for why this (not a real HTTP URL) is what actually gets sent. */
  albumArtUrl: string | null;
}

/**
 * Drives DiscordPresenceBridge (see its own doc - a native bridge on
 * Android, null on web/Windows until Windows gets one too) off the current
 * track, same shape as useLastFmScrobbling: connect once, update on every
 * track change, clear (not just stop updating) when nothing's playing so a
 * paused/stopped session doesn't leave a stale "still listening" status up
 * in the user's Discord profile indefinitely.
 *
 * `bridge` being null (web, or Windows until it has its own module) makes
 * every effect here a no-op - this hook is safe to call unconditionally
 * from App.tsx regardless of platform.
 */
export function useDiscordPresence(
  bridge: DiscordPresenceBridge | null,
  applicationId: string,
  enabled: boolean,
  info: DiscordPresenceTrackInfo | null,
): void {
  const [connected, setConnected] = useState(false);
  const trackStartRef = useRef<{ fileId: string; startedAtUnixMs: number } | null>(null);

  useEffect(() => {
    if (!bridge || !enabled || !applicationId) {
      setConnected(false);
      return;
    }
    let cancelled = false;
    void bridge
      .connect(applicationId)
      .then((ok) => {
        if (!cancelled) setConnected(ok);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
      void bridge.disconnect();
      setConnected(false);
    };
  }, [bridge, enabled, applicationId]);

  useEffect(() => {
    if (!bridge || !connected) return;
    if (!info) {
      trackStartRef.current = null;
      void bridge.sendFrame(buildSetActivityFrame(null));
      return;
    }
    if (trackStartRef.current?.fileId !== info.fileId) {
      trackStartRef.current = { fileId: info.fileId, startedAtUnixMs: Date.now() };
    }
    const nowPlaying: DiscordNowPlayingInfo = {
      title: info.title,
      artist: info.artist,
      startedAtUnixMs: trackStartRef.current.startedAtUnixMs,
      albumArtUrl: info.albumArtUrl,
    };
    void bridge.sendFrame(buildSetActivityFrame(nowPlaying));
    // Deliberately depends on info's individual fields, not `info` itself -
    // the caller (App.tsx) passes a fresh object literal every render, same
    // situation as MediaSessionNotificationInfo's identical note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, connected, info?.fileId, info?.title, info?.artist, info?.albumArtUrl]);
}
