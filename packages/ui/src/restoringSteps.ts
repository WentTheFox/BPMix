/**
 * The fixed, ordered list of high-level phases shown by RestoringScreen -
 * defined once here (rather than in each app) so the wording/order can't
 * drift between apps/mobile/App.tsx and apps/web/src/App.tsx. This is
 * deliberately coarse (one row per phase, not one row per root/lyrics scope
 * scanned within "Scanning library"/"Scanning lyrics") - see each app's
 * refresh() for the per-root/per-scope work these phases cover.
 */
export type RestoringStepKey = 'listingFolders' | 'scanningLibrary' | 'scanningLyrics' | 'restoringPlayback' | 'loadingPlaylist';

export const RESTORING_STEPS: ReadonlyArray<{ key: RestoringStepKey; label: string }> = [
  { key: 'listingFolders', label: 'Listing folders' },
  { key: 'scanningLibrary', label: 'Scanning library' },
  { key: 'scanningLyrics', label: 'Scanning lyrics' },
  { key: 'restoringPlayback', label: 'Restoring playback' },
  { key: 'loadingPlaylist', label: 'Loading playlist' },
];
