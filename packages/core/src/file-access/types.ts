/**
 * Opaque handle to a file inside a user-granted root directory.
 * Shape is intentionally minimal - platform adapters attach whatever
 * native handle/URI they need internally and expose only this surface.
 */
export interface FileRef {
  /** Stable within a root grant; used as the identity key for library/analysis rows. */
  id: string;
  name: string;
  /** Path relative to the root directory that was granted, for display and m3u8 resolution. */
  relativePath: string;
  sizeBytes: number;
  lastModifiedMs: number;
}

export interface DirectoryEntry {
  type: 'file' | 'directory';
  name: string;
  /** Path relative to the granted root; pass to listDirectory/readFile* to descend or read. */
  relativePath: string;
  /** Present when type is 'file'. */
  file?: FileRef;
}

/**
 * One user-granted root (a folder the user picked, which may contain
 * playlists and audio in any nested structure).
 */
export interface GrantedRoot {
  id: string;
  displayName: string;
  /**
   * Defaults to 'library' when absent (older stored roots, and every
   * adapter/root that predates this field). 'lyrics' marks a root granted
   * purely to hold .lrc files via requestRoot('lyrics') - refresh() must
   * never scan one of these for playlists/tracks, so picking an independent
   * lyrics folder via a real OS directory picker doesn't leave a phantom
   * empty "library" entry behind (the exact problem that used to force
   * picking a lyrics folder as a subfolder of an already-granted music root
   * instead - see addLyricsFolder in apps/web/src/App.tsx).
   */
  kind?: 'library' | 'lyrics';
}

/**
 * The single, centralized point of contact for touching a user's files on
 * every platform (web, Android, Windows, and the self-hosted server) -
 * every concrete adapter (fileAccess.ts, fileAccess.android.ts,
 * fileAccess.windows.ts, fileAccess.server.ts) implements exactly this
 * surface and nothing more. Deliberately read-only, for now: there is no
 * write/delete/create/rename method here at all, matching what BPMix
 * actually needs (playing back an existing library, never modifying it).
 * Each adapter's underlying permission request is scoped to match - see
 * e.g. fileAccess.android.ts's requestRoot(), which persists a read-only
 * URI grant (patches/react-native-scoped-storage.patch masks out
 * FLAG_GRANT_WRITE_URI_PERMISSION) even though the OS grants read+write by
 * default, and fileAccess.ts's showDirectoryPicker({ mode: 'read' }). If a
 * future feature genuinely needs to write (e.g. editing tags, generating
 * .lrc files), that's a deliberate, separate expansion of this interface -
 * not something to bolt on ad hoc in one adapter.
 */
export interface FileAccessCallOptions {
  /**
   * Default true. When false, this call must never prompt the user (no
   * requestPermission()-equivalent) - it's running from idle/background
   * scheduling rather than a real user gesture, and browsers reject (throw)
   * an attempt to prompt outside one. Adapters with no such permission
   * model (Android, Windows, the self-hosted server backend) ignore this
   * entirely - only the web adapter's showDirectoryPicker-backed grants
   * have teeth here. See createBackgroundFileAccess.
   */
  allowPrompt?: boolean;
}

/** Thrown instead of prompting when a call is marked allowPrompt: false and the underlying grant needs re-confirming - see FileAccessCallOptions. */
export class FileAccessPermissionPendingError extends Error {
  constructor(rootDisplayName: string) {
    super(`Read permission for "${rootDisplayName}" needs to be re-granted, but this call isn't allowed to prompt for it.`);
    this.name = 'FileAccessPermissionPendingError';
  }
}

export interface FileAccess {
  /** Prompts the platform's directory picker and persists the grant. `kind` (default 'library') is stored on the resulting GrantedRoot - see its doc. */
  requestRoot(kind?: 'library' | 'lyrics'): Promise<GrantedRoot | null>;
  /** Roots granted in a previous session, restored without re-prompting. */
  listGrantedRoots(): Promise<GrantedRoot[]>;
  revokeRoot(rootId: string): Promise<void>;

  /** Lists one level (immediate children only) of a directory; callers recurse via walkDirectory. */
  listDirectory(rootId: string, relativePath?: string, opts?: FileAccessCallOptions): Promise<DirectoryEntry[]>;

  readFileBytes(ref: FileRef, opts?: FileAccessCallOptions): Promise<ArrayBuffer>;
  readFileText(ref: FileRef, opts?: FileAccessCallOptions): Promise<string>;
}
