import type { LibraryStore, ScrobbleTrackInfo } from '@bpmix/core';
import type { AppSettings } from '@bpmix/core';
import { useLastFmScrobbling } from '../scrobble/useLastFmScrobbling';
import { useFastDisplay } from './useFastDisplay';

export interface ScrobbleBridgeProps {
  libraryStore: LibraryStore;
  settings: AppSettings;
  /** Null when nothing has actually played this session. `durationSeconds` is filled in here from the live state. */
  info: Omit<ScrobbleTrackInfo, 'durationSeconds'> | null;
  isPlaying: boolean;
  crossfadeSeconds: number;
}

/**
 * Feeds the Last.fm scrobbler the live position. Headless: it exists so the
 * per-tick position subscription re-renders only this (renderless) component,
 * not the app root that owns the rest of the scrobbling inputs.
 */
export function ScrobbleBridge({ libraryStore, settings, info, isPlaying, crossfadeSeconds }: ScrobbleBridgeProps) {
  const { displayPositionSeconds, displayDurationSeconds } = useFastDisplay(crossfadeSeconds);
  useLastFmScrobbling(libraryStore, settings, info ? { ...info, durationSeconds: displayDurationSeconds } : null, isPlaying, displayPositionSeconds);
  return null;
}
