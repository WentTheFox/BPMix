export interface M3u8Entry {
  /** Path exactly as written in the playlist file, not yet resolved against the library root. */
  rawPath: string;
  durationSeconds?: number;
  title?: string;
}

/**
 * Inverse of parseM3u8 - writes an #EXTINF directive ahead of an entry only
 * when it actually carries duration/title info, same as a plain (non-
 * extended) m3u8 would look for entries that don't. Always writes the
 * #EXTM3U header, so a reader that only recognizes plain path-per-line
 * playlists still works (it just ignores the '#' lines) while one that
 * understands #EXTINF gets the richer version.
 */
export function formatM3u8(entries: M3u8Entry[]): string {
  const lines = ['#EXTM3U'];
  for (const entry of entries) {
    if (entry.durationSeconds !== undefined || entry.title !== undefined) {
      lines.push(`#EXTINF:${Math.round(entry.durationSeconds ?? -1)},${entry.title ?? ''}`);
    }
    lines.push(entry.rawPath);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parses extended-M3U syntax (#EXTM3U / #EXTINF directives). Unknown '#'
 * directives are ignored rather than rejected, since players in the wild
 * write a variety of vendor-specific tags we don't need to understand.
 */
export function parseM3u8(text: string): M3u8Entry[] {
  const entries: M3u8Entry[] = [];
  let pendingDurationSeconds: number | undefined;
  let pendingTitle: string | undefined;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length);
      const commaIndex = rest.indexOf(',');
      const durationPart = commaIndex === -1 ? rest : rest.slice(0, commaIndex);
      const duration = Number(durationPart);
      pendingDurationSeconds = Number.isFinite(duration) ? duration : undefined;
      pendingTitle = commaIndex === -1 ? undefined : rest.slice(commaIndex + 1).trim() || undefined;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    entries.push({
      rawPath: line,
      durationSeconds: pendingDurationSeconds,
      title: pendingTitle,
    });
    pendingDurationSeconds = undefined;
    pendingTitle = undefined;
  }

  return entries;
}

/**
 * Resolves an m3u8 entry's path against the playlist's own location, since
 * playlists reference tracks relative to themselves, not the library root.
 *
 * Entries that look absolute (leading slash, or a Windows drive letter -
 * playlists get authored on whatever OS was handy) can't be resolved
 * against an arbitrary user-granted root, so we fall back to treating the
 * remainder as root-relative rather than failing the entry outright.
 */
export function resolveM3u8EntryPath(playlistRelativePath: string, rawPath: string): string {
  const normalizedEntry = rawPath.replace(/\\/g, '/');
  const isAbsolute = normalizedEntry.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedEntry);
  const entryParts = (isAbsolute ? normalizedEntry.replace(/^[a-zA-Z]:\//, '/') : normalizedEntry).split('/');

  const playlistDirParts = playlistRelativePath.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = isAbsolute ? entryParts : [...playlistDirParts, ...entryParts];

  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join('/');
}

/**
 * Inverse of resolveM3u8EntryPath - expresses a root-relative target path as
 * a path relative to the playlist's own location, for writing a corrected
 * entry back into the m3u8 (see relocateMissingTrack). Always a plain
 * forward-slashed relative path, never absolute - a rewritten entry doesn't
 * need to preserve whatever absolute-path quirk the original happened to be
 * written with, now that the target's real root-relative location is known.
 */
export function relativizeM3u8EntryPath(playlistRelativePath: string, targetRelativePath: string): string {
  const playlistDirParts = playlistRelativePath.split('/').slice(0, -1);
  const targetParts = targetRelativePath.split('/');

  let commonLength = 0;
  while (
    commonLength < playlistDirParts.length &&
    commonLength < targetParts.length - 1 &&
    playlistDirParts[commonLength] === targetParts[commonLength]
  ) {
    commonLength++;
  }

  const ups = playlistDirParts.slice(commonLength).map(() => '..');
  const downs = targetParts.slice(commonLength);
  return [...ups, ...downs].join('/');
}
