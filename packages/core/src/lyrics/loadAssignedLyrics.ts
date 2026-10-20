import type { FileAccess, FileRef } from '../file-access/types';
import type { LibraryStore, LyricsScope } from '../library-store/types';
import { parseLrc, type ParsedLyrics } from './lrc';
import { matchTranslationLines } from './matchTranslationLines';
import { scanLyricsRoot } from './scanLyricsRoot';

/**
 * The lyrics-fetcher service's convention for a translation sibling file:
 * "<track>.<ISO 639-1 code>.lrc" next to the native "<track>.lrc" - e.g.
 * "Dark Horse ft. Juicy J.en.lrc" alongside "Dark Horse ft. Juicy J.lrc".
 * Only English is looked up here, per the product decision to show an
 * English translation line specifically, not any available language.
 */
const TRANSLATION_LANGUAGE_CODE = 'en';

/**
 * Short-TTL cache for scanAllLyricsScopes, keyed per-fileAccess (a WeakMap,
 * so distinct fileAccess instances - e.g. separate test fixtures - never
 * share a cache slot) and then by the scope list. Every lyrics-aware call
 * site (loadAssignedLyrics on every track change, LyricsSection, the
 * auto-match passes) walks the same small set of scopes, so without this a
 * track-to-track skip re-walked the whole lyrics folder from scratch each
 * time - this collapses repeats within a short window into one real scan.
 * Self-expiring rather than explicitly invalidated: cheap, and a lyrics
 * folder changing on disk is rare enough that a few seconds of staleness
 * right after is an acceptable trade for not having to track every scope
 * add/remove call site.
 */
const SCAN_CACHE_TTL_MS = 5000;
const scanCachesByFileAccess = new WeakMap<FileAccess, Map<string, { files: LyricsFileRef[]; fetchedAtMs: number }>>();

function lyricsScopesCacheKey(scopes: LyricsScope[]): string {
  return scopes
    .map((s) => `${s.rootId}:${s.relativePath}`)
    .sort()
    .join('|');
}

/** A lyrics file found while walking a scope, tagged with which scope's rootId it came from - scanAllLyricsScopes flattens every configured scope into one array, so this is the only way a caller (resolveAssignedLyricsFile) can tell which root to read/write a given file through afterward. */
export type LyricsFileRef = FileRef & { rootId: string };

/**
 * Every .lrc file across every configured lyrics scope - the candidate pool
 * for both auto-match and a manual picker. This is the REAL, disk-walking
 * scan (see scanLyricsRoot/walkDirectory) - matchLibraryLyrics is the only
 * caller that should still reach for this directly (it's the thing that
 * then persists the result via lyricsFileIndexSettingKey/putSetting for
 * everyone else to read back). Every other caller should use
 * getLyricsFileIndex instead, which trusts that persisted result rather
 * than re-walking.
 */
export async function scanAllLyricsScopes(fileAccess: FileAccess, scopes: LyricsScope[]): Promise<LyricsFileRef[]> {
  const key = lyricsScopesCacheKey(scopes);
  const now = Date.now();
  const cacheForAccess = scanCachesByFileAccess.get(fileAccess);
  const cached = cacheForAccess?.get(key);
  if (cached && now - cached.fetchedAtMs < SCAN_CACHE_TTL_MS) {
    return cached.files;
  }

  const files = (
    await Promise.all(scopes.map(async (scope) => (await scanLyricsRoot(fileAccess, scope.rootId, scope.relativePath)).map((file) => ({ ...file, rootId: scope.rootId }))))
  ).flat();
  const cache = cacheForAccess ?? new Map<string, { files: LyricsFileRef[]; fetchedAtMs: number }>();
  cache.set(key, { files, fetchedAtMs: now });
  scanCachesByFileAccess.set(fileAccess, cache);
  return files;
}

/** LibraryStore.getSetting/putSetting key matchLibraryLyrics writes its authoritative post-walk file list under, for getLyricsFileIndex to read back - see that function's doc. */
export function lyricsFileIndexSettingKey(scopes: LyricsScope[]): string {
  return `lyricsFileIndex:${lyricsScopesCacheKey(scopes)}`;
}

/**
 * The lyrics-file candidate pool, trusting matchLibraryLyrics's own
 * already-persisted result instead of re-walking disk (see
 * scanAllLyricsScopes's doc). Before this, every track switch re-walked the
 * whole configured lyrics folder from scratch (scanAllLyricsScopes's own
 * in-memory cache only has a 5-second TTL, meant to collapse same-tick
 * repeats, not survive actually browsing around) - on Android in
 * particular each folder level in that walk is a real SAF/
 * DocumentsProvider IPC round-trip (see walk.ts), so a library with
 * hundreds of lyrics files made opening a different track visibly stall on
 * a spinner even though matchLibraryLyrics had already walked the exact
 * same folder moments earlier at launch. Falls back to a real walk (and
 * persists its own result, so the next caller doesn't pay for it either) if
 * nothing's been persisted yet - e.g. a lyrics scope just added, before the
 * background match pass has had a chance to run once.
 */
export async function getLyricsFileIndex(fileAccess: FileAccess, store: LibraryStore, scopes: LyricsScope[]): Promise<LyricsFileRef[]> {
  const key = lyricsFileIndexSettingKey(scopes);
  const persisted = await store.getSetting(key);
  if (persisted) {
    try {
      return JSON.parse(persisted) as LyricsFileRef[];
    } catch {
      // Corrupt or old-shape value (e.g. from before rootId was added) -
      // fall through to a real walk below, which overwrites it.
    }
  }
  const files = await scanAllLyricsScopes(fileAccess, scopes);
  await store.putSetting(key, JSON.stringify(files));
  return files;
}

/** "Track.lrc" -> "Track.en.lrc" - null for a name that doesn't end in .lrc (shouldn't happen for anything scanAllLyricsScopes returns, but keeps this total). */
function translationFileName(nativeName: string): string | null {
  const match = nativeName.match(/^(.*)\.lrc$/i);
  return match ? `${match[1]}.${TRANSLATION_LANGUAGE_CODE}.lrc` : null;
}

/**
 * Resolves and parses whatever .lrc file is currently assigned to a track,
 * or null if none is assigned (or the assigned file can no longer be found -
 * e.g. its scope was removed since). There's no persisted FileRef for an
 * assigned lrc file, only its fileId (see LibraryStore.putLyricsAssignment),
 * so this re-walks every configured lyrics scope to find the matching
 * FileRef - the same candidate pool each app's auto-match refresh() pass
 * builds. Lyrics folders are expected to be small, so re-walking on each
 * track change is cheap enough not to warrant a separate persisted index.
 *
 * The assigned file is always treated as the native/primary language - the
 * lyrics-fetcher service only ever auto-matches/assigns the plain
 * "<track>.lrc" name, never a "<track>.en.lrc" translation sibling, so this
 * doesn't need its own "which one is native" logic. If a same-named
 * translation sibling exists (see translationFileName) and is itself
 * synced, each native line gets that sibling's closest-timestamped line
 * attached as its `translation` (see matchTranslationLines) - a translation
 * that turns out to be unsynced plain text is silently ignored, since there
 * would be no reliable way to line it up per-line.
 */
export async function loadAssignedLyrics(
  fileAccess: FileAccess,
  libraryStore: LibraryStore,
  scopes: LyricsScope[],
  trackFileId: string,
): Promise<ParsedLyrics | null> {
  const lrcFileId = await libraryStore.getLyricsAssignment(trackFileId);
  if (!lrcFileId) return null;

  const files = await getLyricsFileIndex(fileAccess, libraryStore, scopes);
  const file = files.find((f) => f.id === lrcFileId);
  if (!file) return null;

  const native = parseLrc(await fileAccess.readFileText(file));

  const translationName = translationFileName(file.name);
  const translationFile = translationName ? files.find((f) => f.name.toLowerCase() === translationName.toLowerCase()) : undefined;
  if (!translationFile) return native;

  const translation = parseLrc(await fileAccess.readFileText(translationFile));
  return matchTranslationLines(native, translation);
}

/**
 * Resolves a track's assigned .lrc file to its FileRef and the rootId it
 * lives under - what LyricsSyncScreen needs to write the hand-synced result
 * back with fileAccess.writeFileText(rootId, relativePath, ...), neither of
 * which loadAssignedLyrics' own ParsedLyrics return value carries. Goes
 * through getLyricsFileIndex (LyricsFileRef carries rootId per file) rather
 * than walking scopes one at a time - this used to deliberately avoid
 * scanAllLyricsScopes' flattened cache for exactly that reason, which meant
 * every "Save" in LyricsSyncScreen re-walked the whole lyrics folder from
 * scratch right before writing back.
 */
export async function resolveAssignedLyricsFile(
  fileAccess: FileAccess,
  libraryStore: LibraryStore,
  scopes: LyricsScope[],
  trackFileId: string,
): Promise<{ rootId: string; file: FileRef } | null> {
  const lrcFileId = await libraryStore.getLyricsAssignment(trackFileId);
  if (!lrcFileId) return null;
  const files = await getLyricsFileIndex(fileAccess, libraryStore, scopes);
  const file = files.find((f) => f.id === lrcFileId);
  if (!file) return null;
  const { rootId, ...plainFile } = file;
  return { rootId, file: plainFile };
}
