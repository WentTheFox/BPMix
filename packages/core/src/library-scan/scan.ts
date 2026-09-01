import type { FileAccess } from '../file-access/types';
import type { LibraryStore, PlaylistRecord, TrackRecord } from '../library-store/types';
import { parseM3u8, resolveM3u8EntryPath } from '../playlist/m3u8';
import { walkDirectory } from './walk';

export interface ScanResult {
  playlists: PlaylistRecord[];
  tracks: TrackRecord[];
  /** Playlist entries that didn't resolve to a file under the root - surfaced for diagnostics, not fatal. */
  unresolvedEntries: { playlistRelativePath: string; rawPath: string }[];
}

/**
 * Walks a granted root, parses every playlist found in it, and resolves
 * each playlist's entries against the files actually present. Tracks are
 * defined as "files referenced by at least one playlist" - we don't treat
 * every audio-looking file in the tree as library content, since playlists
 * are the thing the user curates and arbitrary folder structure is
 * explicitly not something we organize around.
 *
 * Used both for the initial add-folder scan and for a rescan; upserts are
 * idempotent so re-scanning an unchanged root is a no-op at the store level.
 */
export async function scanRoot(fileAccess: FileAccess, store: LibraryStore, rootId: string): Promise<ScanResult> {
  const { files, playlistFiles } = await walkDirectory(fileAccess, rootId);

  const filesByRelativePath = new Map(files.map((f) => [f.relativePath, f]));
  const tracksById = new Map<string, TrackRecord>();
  const playlists: PlaylistRecord[] = [];
  const unresolvedEntries: ScanResult['unresolvedEntries'] = [];

  for (const playlistFile of playlistFiles) {
    const text = await fileAccess.readFileText(playlistFile);
    const entries = parseM3u8(text);
    const trackFileIds: string[] = [];

    for (const entry of entries) {
      const resolvedPath = resolveM3u8EntryPath(playlistFile.relativePath, entry.rawPath);
      const trackFile = filesByRelativePath.get(resolvedPath);
      if (!trackFile) {
        unresolvedEntries.push({ playlistRelativePath: playlistFile.relativePath, rawPath: entry.rawPath });
        continue;
      }
      trackFileIds.push(trackFile.id);
      tracksById.set(trackFile.id, {
        fileId: trackFile.id,
        rootId,
        relativePath: trackFile.relativePath,
        sizeBytes: trackFile.sizeBytes,
        lastModifiedMs: trackFile.lastModifiedMs,
      });
    }

    playlists.push({
      id: playlistFile.id,
      rootId,
      fileId: playlistFile.id,
      name: playlistFile.name.replace(/\.m3u8?$/i, ''),
      trackFileIds,
    });
  }

  for (const track of tracksById.values()) {
    await store.upsertTrack(track);
  }
  for (const playlist of playlists) {
    await store.upsertPlaylist(playlist);
  }

  return { playlists, tracks: [...tracksById.values()], unresolvedEntries };
}
