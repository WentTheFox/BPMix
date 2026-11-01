// The portable subset of @beatseam/core for apps/server, which bundles core
// (see apps/server/tsup.config.ts's alias). Everything here is plain TS over
// the FileAccess/LibraryStore/AudioEngine interfaces - no Redux store, no
// playback engine, no UI-facing helpers - so the server bundle doesn't drag
// those (and their dependencies) in. Add a module here when the server needs it.
export * from './file-access/types';
export * from './audio-engine/types';
export * from './library-store/types';
export * from './playlist/m3u8';
export * from './scrobble/lastfm';
export * from './lyrics/lrc';
export * from './lyrics/matchLyrics';
export * from './lyrics/scanLyricsRoot';
export * from './lyrics/loadAssignedLyrics';
export * from './lyrics/matchTranslationLines';
export * from './lyrics/ensureLyricsAssignment';
export * from './lyrics/matchLibraryLyrics';
export * from './library-scan/audioFiles';
export * from './library-scan/walk';
export * from './library-scan/scan';
export * from './library-scan/pruneOrphanedRootData';
export * from './library-scan/editPlaylistTracks';
export * from './analysis/analyzeTrack';
export * from './analysis/ensureAnalyzed';
export * from './analysis/loudness';
export * from './analysis/silence';
export * from './metadata/types';
export * from './metadata/contentHash';
export * from './metadata/coverArtResizer';
export * from './metadata/ensureMetadata';
export * from './metadata/parseDuration';
export * from './metadata/readEmbeddedLyrics';
