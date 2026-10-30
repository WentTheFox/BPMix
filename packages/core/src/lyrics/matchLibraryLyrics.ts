import { FileAccessPermissionPendingError, type FileAccess } from '../file-access/types';
import type { LibraryStore, LyricsScope, TrackRecord } from '../library-store/types';
import { requestIdle } from '../metadata/idleCallback';
import { lyricsFileIndexSettingKey, scanAllLyricsScopes } from './loadAssignedLyrics';
import { findAutoLyricsMatch } from './matchLyrics';
import { runJoinableTask } from '../tasks/taskQueue';

/** Same reasoning as scanLibraryMetadata's - bounds how long a chunk can go without real idle time before it's given a slice anyway. */
const IDLE_CALLBACK_TIMEOUT_MS = 2000;

/** LibraryStore.getSetting/putSetting key for the last known matchLibraryLyrics matchedCount - see MatchLibraryLyricsOptions.onSettled's doc. */
export const LYRICS_MATCHED_COUNT_SETTING_KEY = 'lyricsMatchedCount';

export interface MatchLibraryLyricsOptions {
  /** Called after each track's auto-match attempt with the running matched-so-far count, so a caller can update a live "N of M matched" display - plus how many tracks this pass has processed out of its current total (which can grow, see onExtendable). */
  onProgress?: (matchedCount: number, processedCount: number, totalCount: number) => void;
  /**
   * Called each time a processed track turns out to have no lyrics match -
   * whether it never had one, or (rarer) previously did but doesn't
   * anymore. Meant for a caller showing an optimistic "last known total"
   * count immediately on launch (see the app's persisted lyrics-match-count
   * setting) rather than starting from zero/unknown: decrement that
   * optimistic total once per call instead of waiting for this whole pass
   * to finish before showing any number.
   */
  onAnomaly?: () => void;
  /** Called once, when the whole pass finishes, with the exact final matched/total counts (over every track actually processed - excludes skipFileIds) - a caller should persist matchedCount as the next launch's optimistic starting total and snap its live display to this exact value. */
  onSettled?: (matchedCount: number, totalCount: number) => void;
  /** Same shape/purpose as scanLibraryMetadata's - bumps specific tracks (e.g. now-playing/up-next) ahead of scan order, re-evaluated fresh each step. */
  getPriorityFileIds?: () => string[];
  /** Tracks to skip entirely (already resolved elsewhere, e.g. the restoring track via ensureLyricsAssignment on the critical path) - avoids redoing that work here. */
  skipFileIds?: string[];
  /** Same as scanLibraryMetadata's - awaited before each track so the pass can pause for foreground work (see taskQueue.ts). */
  checkpoint?: () => Promise<void>;
  /** Same as scanLibraryMetadata's - lets a later request with the same scopes add its tracks to this pass while it's running instead of queueing a second full pass (see matchLibraryLyricsQueued). */
  onExtendable?: (addTracks: (tracks: TrackRecord[]) => boolean) => void;
}

/**
 * Idle-chunked whole-library lyrics auto-match, meant to run in the
 * background (see ensureLyricsAssignment for the single-track,
 * critical-path version used during startup restore). Never overwrites an
 * existing assignment - re-checks getLyricsAssignment immediately before
 * each write, not just once at the start of a track's turn, since an
 * idle-chunked pass over a large library can run for several seconds+,
 * widening the window in which a user could manually (re)assign a track via
 * LyricsPickerScreen mid-run.
 */
export function matchLibraryLyrics(
  fileAccess: FileAccess,
  store: LibraryStore,
  scopes: LyricsScope[],
  tracks: TrackRecord[],
  options: MatchLibraryLyricsOptions = {},
): Promise<void> {
  const skip = new Set(options.skipFileIds ?? []);
  const remaining = tracks.filter((t) => !skip.has(t.fileId));
  let totalCount = remaining.length;
  let processedCount = 0;
  const seen = new Set(remaining.map((t) => t.fileId));
  let finished = false;
  options.onExtendable?.((more) => {
    if (finished) return false;
    for (const track of more) {
      if (skip.has(track.fileId) || seen.has(track.fileId)) continue;
      seen.add(track.fileId);
      remaining.push(track);
      totalCount++;
    }
    return true;
  });
  if (scopes.length === 0 || totalCount === 0) {
    finished = true;
    return Promise.resolve();
  }

  // A failure past this point (a lyrics root that vanished, a store write error) must reject the
  // returned promise - thrown inside a detached async function it would otherwise be an unhandled
  // rejection while the promise stayed pending forever.
  return new Promise((resolve, reject) => {
    void (async () => {
      let files;
      try {
        files = await scanAllLyricsScopes(fileAccess, scopes);
      } catch (err) {
        // A lapsed browser grant can't be re-requested from this
        // background pass (see FileAccessCallOptions.allowPrompt's doc) -
        // just skip this run entirely rather than crash; it'll pick back up
        // once something gesture-adjacent re-grants access. Anything else
        // (a genuinely broken scope) should still surface.
        if (err instanceof FileAccessPermissionPendingError) {
          finished = true;
          resolve();
          return;
        }
        throw err;
      }
      // Persist this pass's own authoritative walk for getLyricsFileIndex's
      // readers (loadAssignedLyrics, resolveAssignedLyricsFile,
      // ensureLyricsAssignment, LyricsSection's picker) - without this they
      // each re-walked the same lyrics folder from scratch on every track
      // switch/sync-save, right after this exact pass had already walked it
      // at launch or on an explicit Rescan.
      await store.putSetting(lyricsFileIndexSettingKey(scopes), JSON.stringify(files));
      const candidates = files.map((file) => ({ fileId: file.id, name: file.name }));
      let matched = 0;

      const processOne = async (): Promise<void> => {
        let nextIndex = 0;
        const priorityFileIds = options.getPriorityFileIds?.();
        if (priorityFileIds && priorityFileIds.length > 0) {
          const prioritizedIndex = remaining.findIndex((t) => priorityFileIds.includes(t.fileId));
          if (prioritizedIndex !== -1) nextIndex = prioritizedIndex;
        }
        const track = remaining.splice(nextIndex, 1)[0]!;

        const existing = await store.getLyricsAssignment(track.fileId);
        let isMatched = existing !== null;
        if (!isMatched) {
          const trackName = track.relativePath.split('/').pop() ?? track.relativePath;
          const match = findAutoLyricsMatch(trackName, candidates);
          if (match) {
            // Re-check right before writing, not just via the read above -
            // a manual assignment could have landed in the meantime.
            const stillUnassigned = !(await store.getLyricsAssignment(track.fileId));
            if (stillUnassigned) {
              await store.putLyricsAssignment(track.fileId, match.fileId);
              isMatched = true;
            } else {
              isMatched = true; // someone else just assigned it - still a match, just not written by us
            }
          }
        }
        if (isMatched) {
          matched++;
        } else {
          options.onAnomaly?.();
        }
        options.onProgress?.(matched, ++processedCount, totalCount);
      };

      const runChunk = (deadline: { didTimeout: boolean; timeRemaining(): number }) => {
        void (async () => {
          do {
            await options.checkpoint?.();
            await processOne();
          } while (remaining.length > 0 && (deadline.didTimeout || deadline.timeRemaining() > 0));

          if (remaining.length > 0) {
            requestIdle(runChunk, IDLE_CALLBACK_TIMEOUT_MS);
          } else {
            finished = true;
            options.onSettled?.(matched, totalCount);
            resolve();
          }
        })().catch(reject);
      };
      requestIdle(runChunk, IDLE_CALLBACK_TIMEOUT_MS);
    })().catch(reject);
  });
}

/**
 * matchLibraryLyrics as a 'background' task on the shared queue - same
 * idea as scanLibraryMetadataQueued: takes its turn, pauses for
 * higher-priority work between tracks, reports progress to the
 * notification bell, and a request over the same lyrics folders made while
 * a pass runs joins it instead of queueing a second full pass.
 */
export function matchLibraryLyricsQueued(
  fileAccess: FileAccess,
  store: LibraryStore,
  scopes: LyricsScope[],
  tracks: TrackRecord[],
  options: Omit<MatchLibraryLyricsOptions, 'checkpoint'> = {},
): Promise<void> {
  // Only a request over the same lyrics folders can join a running pass -
  // one with a folder added/removed has to re-match everything.
  const joinKey = scopes
    .map((scope) => `${scope.rootId} ${scope.relativePath}`)
    .sort()
    .join('');
  return runJoinableTask({ id: 'lyrics-match', label: 'Matching lyrics', priority: 'background', joinKey }, tracks, ({ checkpoint, reportProgress }, register) =>
    matchLibraryLyrics(fileAccess, store, scopes, tracks, {
      ...options,
      checkpoint,
      onExtendable: register,
      onProgress: (matchedCount, processedCount, totalCount) => {
        reportProgress({ detail: '', current: processedCount, total: totalCount });
        options.onProgress?.(matchedCount, processedCount, totalCount);
      },
    }),
  );
}
