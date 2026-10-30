import type { FileRef } from '../file-access/types';

/**
 * Changing a track's lyrics on the server (admins only): which .lrc file it uses, and the contents of that
 * file. What the lyrics screens use in place of reading and writing .lrc files themselves when the library
 * comes from a server.
 */
export interface ServerLyricsEditing {
  /** The file assigned to the track (null = none) and every file it could be assigned. */
  source(trackFileId: string): Promise<{ assigned: string | null; candidates: FileRef[] }>;
  assign(trackFileId: string, lrcFileId: string | null): Promise<void>;
  /** Writes the lines into the assigned file. */
  save(trackFileId: string, lines: { timeSeconds: number | null; text: string }[]): Promise<void>;
}
