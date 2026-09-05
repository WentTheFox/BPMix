export interface LyricLine {
  /** Seconds from track start, or null for an unsynced (plain-text) lyrics file. */
  timeSeconds: number | null;
  text: string;
}

export interface ParsedLyrics {
  /** True when at least one [mm:ss.xx] timestamp was found - false means `lines` is just the file's text, one line each, with no timing. */
  synced: boolean;
  /** Metadata tags ([ti:], [ar:], [al:], [by:], [offset:], etc.), keyed lowercase, last one wins if repeated. Unknown tags are kept too - callers decide what to use. */
  tags: Record<string, string>;
  /** Sorted by timeSeconds when `synced`; file order otherwise. */
  lines: LyricLine[];
}

// [mm:ss.xx] or [mm:ss] - centiseconds are optional and may be 1-3 digits.
const TIMESTAMP_TAG = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
const METADATA_TAG = /^\[([a-zA-Z]+):(.*)\]$/;

function parseTimestamp(minutes: string, seconds: string): number {
  return Number(minutes) * 60 + Number(seconds);
}

/**
 * Parses standard LRC lyrics ([mm:ss.xx]text, one or more timestamps per
 * line for repeated lines/choruses). Falls back to treating the whole file
 * as unsynced plain-text lyrics (one line per non-empty input line) when no
 * timestamp tag is found anywhere, so a plaintext .lrc-adjacent lyrics file
 * still displays instead of being rejected outright.
 */
export function parseLrc(content: string): ParsedLyrics {
  const tags: Record<string, string> = {};
  const lines: LyricLine[] = [];
  let sawTimestamp = false;

  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    const metadataMatch = line.match(METADATA_TAG);
    const timestamps = [...line.matchAll(TIMESTAMP_TAG)];
    if (timestamps.length === 0) {
      if (metadataMatch) {
        tags[metadataMatch[1]!.toLowerCase()] = metadataMatch[2]!.trim();
      } else {
        lines.push({ timeSeconds: null, text: line });
      }
      continue;
    }

    sawTimestamp = true;
    const lastMatch = timestamps[timestamps.length - 1]!;
    const text = line.slice(lastMatch.index! + lastMatch[0].length).trim();
    for (const match of timestamps) {
      lines.push({ timeSeconds: parseTimestamp(match[1]!, match[2]!), text });
    }
  }

  if (!sawTimestamp) {
    return { synced: false, tags, lines };
  }

  lines.sort((a, b) => a.timeSeconds! - b.timeSeconds!);
  return { synced: true, tags, lines };
}
