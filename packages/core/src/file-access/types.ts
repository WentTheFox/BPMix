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
}

export interface FileAccess {
  /** Prompts the platform's directory picker and persists the grant. */
  requestRoot(): Promise<GrantedRoot | null>;
  /** Roots granted in a previous session, restored without re-prompting. */
  listGrantedRoots(): Promise<GrantedRoot[]>;
  revokeRoot(rootId: string): Promise<void>;

  /** Lists one level (immediate children only) of a directory; callers recurse via walkDirectory. */
  listDirectory(rootId: string, relativePath?: string): Promise<DirectoryEntry[]>;

  readFileBytes(ref: FileRef): Promise<ArrayBuffer>;
  readFileText(ref: FileRef): Promise<string>;
}
