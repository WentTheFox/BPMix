import type { FileAccess, FileRef } from '../file-access/types';
import type { PlaylistRecord, TrackRecord } from '../library-store/types';
import { formatM3u8, parseM3u8, resolveM3u8EntryPath, type M3u8Entry } from '../playlist/m3u8';
import { PlaylistFileNotFoundError } from './addTracksToPlaylist';
import { walkDirectory } from './walk';

/**
 * Re-finds a playlist's own .m3u8 file by walking the root fresh and
 * matching `playlist.fileId` - same as addTracksToPlaylist's own first two
 * lines, factored out so every writer (that function, the two below, and
 * EditPlaylistFileScreen's raw editor) shares one copy of this instead of
 * re-deriving it. Throws PlaylistFileNotFoundError if the id no longer
 * matches anything on disk (moved/renamed/deleted since the last scan).
 */
export async function findPlaylistFile(fileAccess: FileAccess, rootId: string, playlist: PlaylistRecord): Promise<FileRef> {
  const { playlistFiles } = await walkDirectory(fileAccess, rootId);
  const playlistFile = playlistFiles.find((f) => f.id === playlist.fileId);
  if (!playlistFile) throw new PlaylistFileNotFoundError(playlist.name);
  return playlistFile;
}

/** Thrown when movePlaylistTracks is asked to move zero tracks, or to move a track to a position anchored on itself. */
export class InvalidPlaylistMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlaylistMoveError';
  }
}

/**
 * Pairs each parsed M3u8Entry with the fileId it resolves to, via the same
 * resolveM3u8EntryPath logic scanRoot itself uses, matched against a
 * relativePath -> fileId map built from the caller's already-known tracks
 * (see movePlaylistTracks/removePlaylistTracks's own docs for why a fresh
 * walk alone isn't enough here - fileId identity, not just relativePath, is
 * what the caller's selection is expressed in). An entry whose resolved
 * path doesn't match any known track (e.g. the file was deleted since the
 * last scan) gets a null fileId - left alone by both operations below,
 * rather than silently dropped.
 */
function resolveEntries(playlistFile: FileRef, entries: M3u8Entry[], tracksById: Map<string, TrackRecord>): { entry: M3u8Entry; fileId: string | null }[] {
  const fileIdByRelativePath = new Map<string, string>();
  for (const track of tracksById.values()) fileIdByRelativePath.set(track.relativePath, track.fileId);

  return entries.map((entry) => {
    const relativePath = resolveM3u8EntryPath(playlistFile.relativePath, entry.rawPath);
    return { entry, fileId: fileIdByRelativePath.get(relativePath) ?? null };
  });
}

/**
 * Moves one or more existing entries of a real playlist's .m3u8 to just
 * before or after another entry (the "anchor"), identified by fileId -
 * the UI-level building block behind the track list's reorder mode (see
 * CLAUDE.md's playlist-editor TODO). The moved entries keep their own
 * relative order among themselves; everything else keeps its relative
 * order too, as if the moved block had simply been lifted out and
 * reinserted at the anchor.
 *
 * Same convention as addTracksToPlaylist/relocateMissingTrack: doesn't
 * touch LibraryStore - the caller rescans the root afterward so the
 * persisted trackFileIds order comes back through the normal ingestion
 * path, not a second parallel one. Requires FileAccess.writeFileText, same
 * platform caveat as those two (throws on adapters that don't support it
 * yet - Windows, the self-hosted server).
 */
export async function movePlaylistTracks(
  fileAccess: FileAccess,
  rootId: string,
  playlist: PlaylistRecord,
  tracksById: Map<string, TrackRecord>,
  movingFileIds: string[],
  anchorFileId: string,
  position: 'before' | 'after',
): Promise<void> {
  if (movingFileIds.length === 0) throw new InvalidPlaylistMoveError('No tracks selected to move.');
  if (movingFileIds.includes(anchorFileId)) throw new InvalidPlaylistMoveError('Cannot move a track to a position anchored on itself.');

  const playlistFile = await findPlaylistFile(fileAccess, rootId, playlist);
  const entries = parseM3u8(await fileAccess.readFileText(playlistFile));
  const resolved = resolveEntries(playlistFile, entries, tracksById);

  const moving = new Set(movingFileIds);
  const movingEntries = resolved.filter((r) => r.fileId !== null && moving.has(r.fileId)).map((r) => r.entry);
  const remaining = resolved.filter((r) => r.fileId === null || !moving.has(r.fileId));

  const anchorIndex = remaining.findIndex((r) => r.fileId === anchorFileId);
  if (anchorIndex === -1) throw new InvalidPlaylistMoveError('The anchor track is no longer in this playlist.');
  const insertAt = position === 'before' ? anchorIndex : anchorIndex + 1;

  const result = [...remaining.slice(0, insertAt).map((r) => r.entry), ...movingEntries, ...remaining.slice(insertAt).map((r) => r.entry)];
  await fileAccess.writeFileText(rootId, playlistFile.relativePath, formatM3u8(result));
}

/**
 * Removes one or more existing entries from a real playlist's .m3u8,
 * identified by fileId - the other half of the track list's reorder mode
 * (see movePlaylistTracks' own doc for the shared conventions this follows,
 * including not touching LibraryStore and the same writeFileText platform
 * caveat).
 */
export async function removePlaylistTracks(
  fileAccess: FileAccess,
  rootId: string,
  playlist: PlaylistRecord,
  tracksById: Map<string, TrackRecord>,
  removingFileIds: string[],
): Promise<void> {
  if (removingFileIds.length === 0) return;

  const playlistFile = await findPlaylistFile(fileAccess, rootId, playlist);
  const entries = parseM3u8(await fileAccess.readFileText(playlistFile));
  const resolved = resolveEntries(playlistFile, entries, tracksById);

  const removing = new Set(removingFileIds);
  const result = resolved.filter((r) => r.fileId === null || !removing.has(r.fileId)).map((r) => r.entry);
  await fileAccess.writeFileText(rootId, playlistFile.relativePath, formatM3u8(result));
}
