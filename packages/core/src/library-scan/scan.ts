import type { FileAccess } from '../file-access/types';
import type { LibraryStore, PlaylistRecord, TrackRecord } from '../library-store/types';
import { parseM3u8, resolveM3u8EntryPath } from '../playlist/m3u8';
import { ScanCancelledError, walkDirectory } from './walk';

/**
 * A scan's live status, reported through scanRoot's onProgress. 'listing'
 * has no total (the walk only discovers the tree as it goes) - only the
 * running folder/file counts; 'playlists' and 'saving' do know their total
 * up front, so `current`/`total` are meaningful for those two.
 */
export interface ScanProgress {
  phase: 'listing' | 'playlists' | 'saving';
  foldersListed: number;
  filesFound: number;
  current: number;
  total: number;
}

export interface ScanResult {
  playlists: PlaylistRecord[];
  tracks: TrackRecord[];
  /** Playlist entries that didn't resolve to a file under the root - surfaced for diagnostics, not fatal (each also gets a `missing: true` placeholder TrackRecord - see missingTrackId). */
  unresolvedEntries: { playlistRelativePath: string; playlistName: string; rawPath: string; resolvedPath: string }[];
}

/**
 * Deterministic id for a missing-track placeholder, derived from where it
 * was expected to be rather than a real FileRef.id (there's no file to have
 * one) - stable across rescans so the exact same missing entry upserts in
 * place instead of accumulating a fresh placeholder row every time, and so
 * "locate this file" (relocateMissingTrack) can be pointed at the same
 * resolvedPath it was synthesized from.
 */
export function missingTrackId(rootId: string, resolvedPath: string): string {
  return `missing:${rootId}:${resolvedPath}`;
}

/**
 * Turns a scan's unresolvedEntries into a notification-ready title/detail
 * pair (see NotificationCenter.addError) - null when there's nothing to
 * report. Shared between apps/web and apps/mobile's App.tsx (both call
 * scanRoot via useLibraryRootActions) so the wording can't drift between
 * them the way a per-app ad hoc message would.
 */
export function describeUnresolvedEntries(
  unresolvedEntries: ScanResult['unresolvedEntries'],
  rootDisplayName: string,
): { title: string; detail: string } | null {
  if (unresolvedEntries.length === 0) return null;
  const title = `${unresolvedEntries.length} missing file${unresolvedEntries.length === 1 ? '' : 's'} in "${rootDisplayName}"`;
  const detail = unresolvedEntries.map((e) => `${e.playlistName}: ${e.rawPath}`).join('\n');
  return { title, detail };
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
 *
 * `signal`, when given, lets a caller cancel a scan in progress (e.g. a user
 * backing out of a slow rescan) - checked between the walk, each playlist
 * file read, and each store upsert, throwing ScanCancelledError as soon as
 * it fires. Prefer scanRootCoordinated (scanCoordinator.ts) over calling
 * this directly from UI code - it also de-dupes concurrent scans of the
 * same root, which this function alone doesn't guard against.
 *
 * `onProgress` is called after every directory listing, playlist read and
 * store write - often, for a big library, so throttle before rendering it
 * (scanRootCoordinated already does).
 */
export async function scanRoot(
  fileAccess: FileAccess,
  store: LibraryStore,
  rootId: string,
  signal?: AbortSignal,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  let walked = { foldersListed: 0, filesFound: 0 };
  const { files, playlistFiles } = await walkDirectory(fileAccess, rootId, undefined, signal, (progress) => {
    walked = progress;
    onProgress?.({ phase: 'listing', ...progress, current: 0, total: 0 });
  });
  const report = (phase: 'playlists' | 'saving', current: number, total: number) => onProgress?.({ phase, ...walked, current, total });

  const filesByRelativePath = new Map(files.map((f) => [f.relativePath, f]));
  const tracksById = new Map<string, TrackRecord>();
  const playlists: PlaylistRecord[] = [];
  const unresolvedEntries: ScanResult['unresolvedEntries'] = [];

  for (const [index, playlistFile] of playlistFiles.entries()) {
    if (signal?.aborted) throw new ScanCancelledError();
    report('playlists', index, playlistFiles.length);
    const text = await fileAccess.readFileText(playlistFile);
    const entries = parseM3u8(text);
    const trackFileIds: string[] = [];

    const playlistName = playlistFile.name.replace(/\.m3u8?$/i, '');

    for (const entry of entries) {
      const resolvedPath = resolveM3u8EntryPath(playlistFile.relativePath, entry.rawPath);
      const trackFile = filesByRelativePath.get(resolvedPath);
      if (!trackFile) {
        unresolvedEntries.push({ playlistRelativePath: playlistFile.relativePath, playlistName, rawPath: entry.rawPath, resolvedPath });
        // A placeholder, not a dropped entry - see TrackRecord.missing's doc.
        // sizeBytes/lastModifiedMs are 0 (there's no real file to read them
        // from); relativePath is where it was expected, so trackDisplayName
        // shows its filename rather than nothing.
        const id = missingTrackId(rootId, resolvedPath);
        trackFileIds.push(id);
        tracksById.set(id, { fileId: id, rootId, relativePath: resolvedPath, sizeBytes: 0, lastModifiedMs: 0, missing: true });
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
      name: playlistName,
      trackFileIds,
    });
  }

  // Checked once more before committing anything - a cancel that lands
  // right after the last playlist read finishes but before upserts start
  // shouldn't still write a scan's worth of tracks/playlists to the store.
  if (signal?.aborted) throw new ScanCancelledError();

  const saveTotal = tracksById.size + playlists.length;
  let saved = 0;
  for (const track of tracksById.values()) {
    report('saving', saved++, saveTotal);
    await store.upsertTrack(track);
  }
  for (const playlist of playlists) {
    report('saving', saved++, saveTotal);
    await store.upsertPlaylist(playlist);
  }

  return { playlists, tracks: [...tracksById.values()], unresolvedEntries };
}
