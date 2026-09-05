/** Filename without its extension, case-folded - the basis for auto-matching a track to a same-named .lrc file. */
export function lyricsStem(filename: string): string {
  const withoutExtension = filename.replace(/\.[^./\\]+$/, '');
  return withoutExtension.trim().toLowerCase();
}

export interface LyricsCandidate {
  fileId: string;
  name: string;
}

/**
 * Auto-assigns a track to a same-stemmed .lrc file (e.g. "Track.mp3" <->
 * "Track.lrc"), the way most desktop players match sidecar lyrics. One .lrc
 * file may legitimately match multiple tracks (different quality/format
 * files for the same song), so this only needs to be unambiguous from the
 * *track's* side: if more than one .lrc candidate shares the track's stem,
 * there's no principled way to prefer one over another automatically, so it
 * returns null and leaves the choice to a manual override instead of
 * guessing.
 */
export function findAutoLyricsMatch(trackFilename: string, candidates: LyricsCandidate[]): LyricsCandidate | null {
  const stem = lyricsStem(trackFilename);
  const matches = candidates.filter((candidate) => lyricsStem(candidate.name) === stem);
  return matches.length === 1 ? matches[0]! : null;
}
