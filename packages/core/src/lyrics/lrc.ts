export interface LyricLine {
  /** Seconds from track start, or null for an unsynced (plain-text) lyrics file. */
  timeSeconds: number | null;
  text: string;
  /**
   * The matching line from a sibling translation .lrc file, if one is
   * assigned and lines up within tolerance - see matchTranslationLines.
   * Always absent (not just null) on a plain parseLrc() result; only
   * populated by that merge step.
   */
  translation?: string | null;
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

/** `83.4` -> `"01:23.40"` - the [mm:ss.xx] timestamp format parseLrc's TIMESTAMP_TAG regex above reads back. */
function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
}

/**
 * Inverse of parseLrc, for writing a freshly hand-synced result back out
 * (see LyricsSyncScreen) - a line with a null timeSeconds is written as
 * plain unsynced text (parseLrc already tolerates a mix of timed and
 * plain lines in one file; `synced` there just means "at least one
 * timestamp was found anywhere", not "every line has one"). `translation`
 * is never written - it only ever exists on a merged in-memory
 * ParsedLyrics (see matchTranslationLines), not a single real .lrc file on
 * disk.
 */
export function formatLrc(lines: LyricLine[], tags: Record<string, string> = {}): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    out.push(`[${key}:${value}]`);
  }
  for (const line of lines) {
    out.push(line.timeSeconds === null ? line.text : `[${formatTimestamp(line.timeSeconds)}]${line.text}`);
  }
  return `${out.join('\n')}\n`;
}
