import type { ScrobbleEntry } from './lastfm';

/**
 * Cap on how many failed scrobbles get held for retry - Last.fm's own
 * track.scrobble batch limit (see scrobbleBatch) is 50 per call, so this
 * just needs to comfortably outlast a stretch of being offline without
 * growing the persisted settings value unboundedly; oldest entries are
 * dropped first once it's exceeded.
 */
export const MAX_QUEUED_SCROBBLES = 200;

function isScrobbleEntry(value: unknown): value is ScrobbleEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.artist === 'string' &&
    typeof v.track === 'string' &&
    typeof v.timestamp === 'number' &&
    (v.album === null || typeof v.album === 'string') &&
    (v.durationSeconds === null || typeof v.durationSeconds === 'number')
  );
}

/** Parses the queue persisted via LibraryStore's generic settings store - corrupt/foreign JSON is treated as an empty queue rather than thrown, since losing a handful of not-yet-submitted scrobbles is harmless. */
export function decodeScrobbleQueue(raw: string | null): ScrobbleEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isScrobbleEntry) : [];
  } catch {
    return [];
  }
}

export function encodeScrobbleQueue(entries: ScrobbleEntry[]): string {
  return JSON.stringify(entries);
}

export function appendToScrobbleQueue(existing: ScrobbleEntry[], entry: ScrobbleEntry): ScrobbleEntry[] {
  const next = [...existing, entry];
  return next.length > MAX_QUEUED_SCROBBLES ? next.slice(next.length - MAX_QUEUED_SCROBBLES) : next;
}
