import type { LibraryStore, NowPlayingInfo, ScrobbleSink } from '@beatseam/core';
import { useLastFmScrobbling } from '../scrobble/useLastFmScrobbling';
import { useFastDisplay } from './useFastDisplay';

export interface ScrobbleBridgeProps {
  libraryStore: LibraryStore;
  /** Where scrobbles go (see ScrobbleSink); null while nothing is connected. */
  sink: ScrobbleSink | null;
  /** See useLastFmScrobbling's queueKeyWhenDisconnected. */
  queueKeyWhenDisconnected?: string;
  /** Identity of the current play (not display text); null when nothing has actually played this session. */
  fileId: string | null;
  /** The same resolved info the UI shows (see resolveNowPlayingInfo). Nothing is sent until its tags are read, so a filename or placeholder is never scrobbled. */
  nowPlaying: NowPlayingInfo | null;
  isPlaying: boolean;
  crossfadeSeconds: number;
}

/**
 * Feeds the Last.fm scrobbler the live position. Headless: it exists so the
 * per-tick position subscription re-renders only this (renderless) component,
 * not the app root that owns the rest of the scrobbling inputs.
 */
export function ScrobbleBridge({ libraryStore, sink, queueKeyWhenDisconnected, fileId, nowPlaying, isPlaying, crossfadeSeconds }: ScrobbleBridgeProps) {
  const { displayPositionSeconds, displayDurationSeconds } = useFastDisplay(crossfadeSeconds);
  useLastFmScrobbling(libraryStore, sink, fileId && nowPlaying?.metadataReady ? { fileId, title: nowPlaying.title, artist: nowPlaying.artist ?? 'Unknown artist', album: nowPlaying.album, durationSeconds: displayDurationSeconds } : null, isPlaying, displayPositionSeconds, queueKeyWhenDisconnected);
  return null;
}
