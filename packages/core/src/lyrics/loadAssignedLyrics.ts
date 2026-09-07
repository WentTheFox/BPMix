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

/** Every .lrc file across every configured lyrics scope - the candidate pool for both auto-match and a manual picker. */
export async function scanAllLyricsScopes(fileAccess: FileAccess, scopes: LyricsScope[]): Promise<FileRef[]> {
  return (await Promise.all(scopes.map((scope) => scanLyricsRoot(fileAccess, scope.rootId, scope.relativePath)))).flat();
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

  const files = await scanAllLyricsScopes(fileAccess, scopes);
  const file = files.find((f) => f.id === lrcFileId);
  if (!file) return null;

  const native = parseLrc(await fileAccess.readFileText(file));

  const translationName = translationFileName(file.name);
  const translationFile = translationName ? files.find((f) => f.name.toLowerCase() === translationName.toLowerCase()) : undefined;
  if (!translationFile) return native;

  const translation = parseLrc(await fileAccess.readFileText(translationFile));
  return matchTranslationLines(native, translation);
}
