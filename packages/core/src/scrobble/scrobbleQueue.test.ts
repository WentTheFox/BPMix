import { describe, expect, it } from 'vitest';
import { appendToScrobbleQueue, decodeScrobbleQueue, encodeScrobbleQueue, MAX_QUEUED_SCROBBLES } from './scrobbleQueue';
import type { ScrobbleEntry } from './lastfm';

const ENTRY: ScrobbleEntry = { artist: 'A', track: 'T', timestamp: 1, album: null, durationSeconds: 200 };

describe('scrobbleQueue', () => {
  it('round-trips through encode/decode', () => {
    const encoded = encodeScrobbleQueue([ENTRY]);
    expect(decodeScrobbleQueue(encoded)).toEqual([ENTRY]);
  });

  it('treats missing/corrupt/foreign JSON as an empty queue', () => {
    expect(decodeScrobbleQueue(null)).toEqual([]);
    expect(decodeScrobbleQueue('not json')).toEqual([]);
    expect(decodeScrobbleQueue('{"not":"an array"}')).toEqual([]);
    expect(decodeScrobbleQueue('[{"garbage":true}]')).toEqual([]);
  });

  it('caps the queue length, dropping the oldest entries first', () => {
    let queue: ScrobbleEntry[] = [];
    for (let i = 0; i < MAX_QUEUED_SCROBBLES + 10; i++) {
      queue = appendToScrobbleQueue(queue, { ...ENTRY, timestamp: i });
    }
    expect(queue.length).toBe(MAX_QUEUED_SCROBBLES);
    expect(queue[0]?.timestamp).toBe(10);
    expect(queue[queue.length - 1]?.timestamp).toBe(MAX_QUEUED_SCROBBLES + 9);
  });
});
