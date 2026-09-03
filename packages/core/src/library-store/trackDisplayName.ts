import type { TrackRecord } from './types';

/** A track's display name - just its filename, not the full relativePath (which includes the folder structure within the granted root). */
export function trackDisplayName(track: TrackRecord): string {
  return track.relativePath.split('/').pop() ?? track.relativePath;
}
