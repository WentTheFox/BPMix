/**
 * Where downloaded audio lives on a platform. The backend does the transfer itself - streaming it to
 * disk and hashing it where it can do so natively - so the JS thread never holds or hashes a whole
 * track just to save it. Writes must be atomic: a file that exists is a complete file.
 */
export interface OfflineBackend {
  /** Fetches `url` (with `headers`) into storage under `fileId`, replacing any earlier copy, and reports what it stored. */
  download(request: {
    fileId: string;
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    onProgress?: (bytesSoFar: number) => void;
  }): Promise<{ sizeBytes: number; sha256: string }>;
  /** The stored bytes, or null if there are none. */
  read(fileId: string): Promise<ArrayBuffer | null>;
  remove(fileId: string): Promise<void>;
  /** Everything currently stored. */
  list(): Promise<{ fileId: string; sizeBytes: number }[]>;
}

/** A track kept for offline play. */
export interface OfflineRecord {
  fileId: string;
  sizeBytes: number;
  /** What the server said the file hashes to (and what was verified on arrival); a change on the server makes this copy stale. */
  sha256: string;
  downloadedAtMs: number;
  lastUsedAtMs: number;
  /** Asked for explicitly (a playlist made available offline); never evicted automatically. */
  pinned: boolean;
}

export interface OfflineFailure {
  fileId: string;
  message: string;
}

export interface OfflineState {
  downloadedCount: number;
  downloadedBytes: number;
  /** Waiting for a turn (not counting those in flight). */
  queuedCount: number;
  activeCount: number;
  /** Bytes received so far for each download in flight. */
  progress: Record<string, number>;
  /** 0 means no limit. Unpinned copies are evicted, least recently played first, to stay under it. */
  budgetBytes: number;
  /** Not transferring: the server can't be reached (or the sign-in lapsed). Resumes on its own when it can. */
  paused: boolean;
  /** Recent downloads that gave up, newest last. */
  failures: OfflineFailure[];
}
