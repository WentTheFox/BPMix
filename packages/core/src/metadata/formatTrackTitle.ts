import { trackDisplayName } from '../library-store/trackDisplayName';
import type { TrackRecord } from '../library-store/types';
import type { TrackMetadata } from './types';

/** "Title — Artist" when metadata has a title, falling back to the bare filename (trackDisplayName) until it's scanned or when the file has no tags. */
export function formatTrackTitle(metadata: TrackMetadata | null, track: TrackRecord): string {
  if (!metadata?.title) return trackDisplayName(track);
  const artists = metadata.artists.join(', ');
  return artists ? `${metadata.title} — ${artists}` : metadata.title;
}
