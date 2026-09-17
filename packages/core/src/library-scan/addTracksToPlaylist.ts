import type { FileAccess } from '../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../library-store/types';
import { formatM3u8, parseM3u8, relativizeM3u8EntryPath } from '../playlist/m3u8';
import { walkDirectory } from './walk';

/** Thrown when playlist.fileId no longer matches any .m3u8 actually found under rootId - it was moved/deleted since the last scan. */
export class PlaylistFileNotFoundError extends Error {
  constructor(playlistName: string) {
    super(`Could not find the playlist file for "${playlistName}" - it may have been moved, renamed, or deleted since the last scan.`);
    this.name = 'PlaylistFileNotFoundError';
  }
}

/**
 * Adds tracks to the start or end of an existing real playlist's own
 * .m3u8, expressed relative to the playlist's own location (a playlist
 * references tracks relative to itself, not the library root - see
 * relativizeM3u8EntryPath's doc). Built for the Unplaylisted automatic
 * view's "add to playlist" action (see AddToPlaylistDialog), but works on
 * any real PlaylistRecord.
 *
 * Deliberately doesn't touch LibraryStore itself, same convention as
 * writePlaylistFile/relocateMissingTrack - the caller rescans the root
 * afterward, so the playlist's persisted trackFileIds go through the exact
 * same ingestion path as any other externally-edited .m3u8 rather than a
 * second, parallel way of updating LibraryStore that exists only for this
 * one path.
 *
 * Doesn't de-duplicate against the playlist's existing entries - the one
 * current caller (adding from Unplaylisted) can only ever offer tracks that
 * aren't already in any playlist, so a duplicate here would mean the
 * library was rescanned out from under the dialog rather than something
 * this function needs to guard against itself.
 *
 * Requires FileAccess.writeFileText, same platform caveat as
 * relocateMissingTrack/writePlaylistFile (throws on adapters that don't
 * support it yet - Windows, the self-hosted server - see CLAUDE.md's
 * housekeeping TODO).
 */
export async function addTracksToPlaylist(
  fileAccess: FileAccess,
  rootId: string,
  playlist: PlaylistRecord,
  tracksToAdd: TrackRecord[],
  position: 'start' | 'end' = 'end',
): Promise<void> {
  if (tracksToAdd.length === 0) return;

  const { playlistFiles } = await walkDirectory(fileAccess, rootId);
  const playlistFile = playlistFiles.find((f) => f.id === playlist.fileId);
  if (!playlistFile) throw new PlaylistFileNotFoundError(playlist.name);

  const existingEntries = parseM3u8(await fileAccess.readFileText(playlistFile));
  const newEntries = tracksToAdd.map((track) => ({ rawPath: relativizeM3u8EntryPath(playlistFile.relativePath, track.relativePath) }));
  const merged = position === 'start' ? [...newEntries, ...existingEntries] : [...existingEntries, ...newEntries];
  await fileAccess.writeFileText(rootId, playlistFile.relativePath, formatM3u8(merged));
}
