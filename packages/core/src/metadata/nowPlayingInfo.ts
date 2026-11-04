import type { TrackRecord } from '../library-store/types';
import { trackDisplayName } from '../library-store/trackDisplayName';
import { isMetadataCurrent } from './ensureMetadata';
import type { TrackMetadata } from './types';

/** What the UI shows for the current track, resolved once so Last.fm, Discord and the media session can't drift from it. */
export interface NowPlayingInfo {
  /** Tag title, else the filename. Same text as the UI's track name. */
  title: string;
  /** Joined tag artists, null when the track has none. Callers needing a string (Last.fm requires one) choose their own fallback. */
  artist: string | null;
  album: string | null;
  /** False until the track's tags have been read: until then title is only a filename, which must not be sent to external services. */
  metadataReady: boolean;
}

/** Single source of truth for the current track's title/artist/album. `track` undefined (not loaded yet) yields null. */
export function resolveNowPlayingInfo(track: TrackRecord | undefined, metadata: TrackMetadata | null): NowPlayingInfo | null {
  if (!track) return null;
  return {
    title: metadata?.title || trackDisplayName(track),
    artist: metadata?.artists.join(', ') || null,
    album: metadata?.album ?? null,
    metadataReady: isMetadataCurrent(metadata),
  };
}
