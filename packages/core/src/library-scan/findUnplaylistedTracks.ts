import type { FileAccess } from '../file-access/types';
import type { LibraryStore, TrackRecord } from '../library-store/types';
import { isAudioFileName } from './audioFiles';
import { scanLibraryMetadataQueued, type ScanLibraryMetadataOptions } from '../metadata/scanLibraryMetadata';
import { runTask, type TaskProgress } from '../tasks/taskQueue';
import { walkDirectory } from './walk';

/**
 * Every track under `rootId` that no current playlist references - the
 * "songs not in a playlist" library-wide view (see CLAUDE.md's UI/UX TODO
 * this implements). Two different things land in this list, both handled
 * here:
 *  - a track scanRoot already knows about (a real TrackRecord, because some
 *    playlist referenced it once) whose owning playlist was since edited or
 *    deleted, orphaning it - a cheap diff against already-loaded data, no
 *    walk needed
 *  - a file that was never referenced by any playlist at all, so scanRoot
 *    (deliberately playlist-first - see its own doc) never turned it into a
 *    TrackRecord in the first place. This function does the one full
 *    audio-file walk needed to find those (same approach as
 *    createPlaylistFromFolder's findPlaylistCandidateTracks, minus the tag
 *    read - a bare TrackRecord doesn't need tags, just file identity/stat
 *    fields, and normal metadata scanning picks it up from here) and
 *    upserts each newly-found one into the store so it becomes a real,
 *    permanent library track from here on - metadata/cover art then work on
 *    it exactly like any other track. Only the *playlist membership* stays
 *    computed fresh on every call rather than persisted, since that's the
 *    part that's actually "dynamic" - a track can drop in or out of this
 *    list the moment a playlist is edited, with no rescan needed.
 *
 * Deliberately not part of scanRoot's own pass (which stays fast/idle-safe
 * for the startup restore path - see CLAUDE.md's own note on that) - this
 * does a real directory walk, so it's meant to be called from an explicit,
 * user-initiated action only (e.g. a "Songs not in a playlist" button),
 * never on every app launch/focus refresh.
 */
export async function findUnplaylistedTracks(
  fileAccess: FileAccess,
  libraryStore: LibraryStore,
  rootId: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<TrackRecord[]> {
  const [playlists, existingTracks] = await Promise.all([libraryStore.listPlaylists(rootId), libraryStore.listTracks(rootId)]);
  const byFileId = new Map(existingTracks.map((track) => [track.fileId, track]));

  const { files } = await walkDirectory(fileAccess, rootId, undefined, undefined, ({ foldersListed, filesFound }) =>
    onProgress?.({ detail: `${filesFound} files in ${foldersListed} folder${foldersListed === 1 ? '' : 's'}`, current: 0, total: 0 }),
  );
  const newlyDiscovered: TrackRecord[] = [];
  for (const file of files) {
    if (!isAudioFileName(file.name) || byFileId.has(file.id)) continue;
    const track: TrackRecord = {
      fileId: file.id,
      rootId,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      lastModifiedMs: file.lastModifiedMs,
    };
    byFileId.set(track.fileId, track);
    newlyDiscovered.push(track);
  }
  let saved = 0;
  await Promise.all(
    newlyDiscovered.map(async (track) => {
      await libraryStore.upsertTrack(track);
      onProgress?.({ detail: 'saving new tracks', current: ++saved, total: newlyDiscovered.length });
    }),
  );

  const referenced = new Set(playlists.flatMap((playlist) => playlist.trackFileIds));
  return [...byFileId.values()].filter((track) => !referenced.has(track.fileId) && !track.missing);
}

/**
 * findUnplaylistedTracks as a 'foreground' task on the shared queue (see
 * taskQueue.ts) - waits for any folder scan in progress, pauses background
 * metadata/lyrics passes while it walks, and shows its progress in the
 * notification bell.
 *
 * Then queues (not awaited) a 'visible' metadata pass over the returned
 * tracks: tracks found here for the first time have never had their tags
 * read, and the library-wide metadata pass only covers tracks that existed
 * when it started. As 'visible' work it takes turns with that pass instead
 * of racing it for the same files, but goes ahead of it - it pauses at its
 * next track - so what's on screen fills in first. Already-fresh tracks are
 * skipped without a read.
 */
export async function findUnplaylistedTracksQueued(
  fileAccess: FileAccess,
  libraryStore: LibraryStore,
  rootId: string,
  rootDisplayName: string,
  /** Options for the queued metadata pass - `fileAccess` overrides the one used for it (e.g. web's non-prompting createBackgroundFileAccess wrapper, since nothing user-initiated is behind that pass). */
  metadataOptions: Omit<ScanLibraryMetadataOptions, 'checkpoint'> & { fileAccess?: FileAccess } = {},
): Promise<TrackRecord[]> {
  const { fileAccess: metadataFileAccess = fileAccess, ...scanOptions } = metadataOptions;
  const tracks = await runTask(
    { id: `unplaylisted-${rootId}`, label: `Finding songs not in a playlist in "${rootDisplayName}"`, priority: 'foreground' },
    ({ reportProgress }) => findUnplaylistedTracks(fileAccess, libraryStore, rootId, reportProgress),
  );
  void scanLibraryMetadataQueued(
    { id: `metadata-unplaylisted-${rootId}`, label: `Reading tags for songs not in a playlist in "${rootDisplayName}"`, priority: 'visible' },
    metadataFileAccess,
    libraryStore,
    tracks,
    scanOptions,
  );
  return tracks;
}
