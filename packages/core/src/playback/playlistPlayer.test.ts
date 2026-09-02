import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import { PlaylistPlayer } from './playlistPlayer';

class FakeAudioEngine implements AudioEngine {
  clock = 0;
  private nextId = 0;
  private endedCallbacks = new Map<string, () => void>();
  /** id of the most recently created source, so tests can fire its ended callback without tracking ids by hand. */
  lastSourceId: string | null = null;
  gainBySourceId = new Map<string, number>();

  async decodeFile(_ref: FileRef): Promise<DecodedAudio> {
    return { sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 10 };
  }

  createSource(_audio: DecodedAudio, onEnded?: () => void): SourceNode {
    const id = `source-${this.nextId++}`;
    this.lastSourceId = id;
    if (onEnded) this.endedCallbacks.set(id, onEnded);
    return {
      id,
      setGain: (value) => this.gainBySourceId.set(id, value),
      rampGain: () => {},
      setRate: () => {},
      rampRate: () => {},
      stop: () => {},
    };
  }

  scheduleStart(): void {}

  now(): number {
    return this.clock;
  }

  fireEndedOnCurrentSource(): void {
    if (this.lastSourceId) this.endedCallbacks.get(this.lastSourceId)?.();
  }
}

function makeFileRef(fileId: string): FileRef {
  return { id: fileId, name: `${fileId}.mp3`, relativePath: `${fileId}.mp3`, sizeBytes: 0, lastModifiedMs: 0 };
}

/** Flushes the microtask queue enough times for playAt's decode->load->play await chain to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

const TRACKS = ['a', 'b', 'c'];

describe('PlaylistPlayer', () => {
  let engine: FakeAudioEngine;
  let player: PlaylistPlayer;

  beforeEach(async () => {
    engine = new FakeAudioEngine();
    player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS);
  });

  it('starts on the first track in sequential order', () => {
    const state = player.getState();
    expect(state.position).toBe(0);
    expect(state.currentFileId).toBe('a');
    expect(state.totalTracks).toBe(3);
  });

  it('setPlaylist can start on a specific track', async () => {
    await player.setPlaylist(TRACKS, 'b');
    expect(player.getState().currentFileId).toBe('b');
  });

  it('next() advances sequentially and stops at the end when loop is off', async () => {
    await player.next();
    expect(player.getState().currentFileId).toBe('b');
    await player.next();
    expect(player.getState().currentFileId).toBe('c');
    await player.next(); // already at the last track, loop off - no-op
    expect(player.getState().currentFileId).toBe('c');
  });

  it('next() wraps to the first track when loop is "all"', async () => {
    player.setLoopMode('all');
    await player.next();
    await player.next();
    expect(player.getState().currentFileId).toBe('c');
    await player.next();
    expect(player.getState().currentFileId).toBe('a');
  });

  it('previous() steps back and wraps under loop "all"', async () => {
    await player.next(); // b
    await player.previous();
    expect(player.getState().currentFileId).toBe('a');
    await player.previous(); // already first, loop off - no-op
    expect(player.getState().currentFileId).toBe('a');

    player.setLoopMode('all');
    await player.previous();
    expect(player.getState().currentFileId).toBe('c');
  });

  it('a track ending naturally advances to the next one', async () => {
    engine.fireEndedOnCurrentSource();
    await flush();
    expect(player.getState().currentFileId).toBe('b');
  });

  it('loop "one" replays the same track on natural end', async () => {
    player.setLoopMode('one');
    engine.fireEndedOnCurrentSource();
    await flush();
    expect(player.getState().currentFileId).toBe('a');
  });

  it('loop "one" makes manual next()/previous() restart the current track instead of changing tracks', async () => {
    player.setLoopMode('one');
    await player.next();
    expect(player.getState().currentFileId).toBe('a');
    expect(player.getState().track.positionSeconds).toBe(0);

    await player.previous();
    expect(player.getState().currentFileId).toBe('a');
  });

  it('next()/previous() with { force: true } always moves tracks even under loop "one"', async () => {
    player.setLoopMode('one');
    await player.next({ force: true });
    expect(player.getState().currentFileId).toBe('b');
    await player.previous({ force: true });
    expect(player.getState().currentFileId).toBe('a');
  });

  it('{ force: true } wraps at the playlist boundary even under loop "off"', async () => {
    await player.previous({ force: true }); // already first, off - force wraps to the last track
    expect(player.getState().currentFileId).toBe('c');
    await player.next({ force: true }); // wraps back to the first
    expect(player.getState().currentFileId).toBe('a');
  });

  it('loop "all" wraps on natural end of the last track', async () => {
    player.setLoopMode('all');
    await player.next();
    await player.next(); // now on 'c', the last track
    engine.fireEndedOnCurrentSource();
    await flush();
    expect(player.getState().currentFileId).toBe('a');
  });

  it('loop "off" stops (does not advance) when the last track ends naturally', async () => {
    await player.next();
    await player.next(); // now on 'c', the last track
    engine.fireEndedOnCurrentSource();
    await flush();
    expect(player.getState().currentFileId).toBe('c');
    expect(player.getState().track.status).toBe('stopped');
  });

  it('overlapping playAt calls do not race - only the latest one is allowed to start playback', async () => {
    // Second half of the fix for a real native crash: two next() calls fired
    // close enough together (rapid manual skips, or a duplicate/spurious
    // onEnded) both begin decoding before either finishes: only the second's
    // eventual .play() should run, not both.
    const first = player.next(); // begins loading 'b'
    const second = player.next(); // begins loading 'c' before 'b' finishes loading
    await Promise.all([first, second]);
    expect(player.getState().currentFileId).toBe('c');
    expect(player.getState().track.status).toBe('playing');
  });

  it('shuffle produces a permutation of all tracks and keeps the current track playing when toggled', async () => {
    await player.next(); // now on 'b'
    const currentBefore = player.getState().currentFileId;
    player.setShuffle(true);
    const stateAfter = player.getState();
    expect(stateAfter.shuffleEnabled).toBe(true);
    expect(stateAfter.currentFileId).toBe(currentBefore); // still 'b', just possibly a new position
  });

  it('shuffled playback still visits every track exactly once per cycle', async () => {
    // loop 'all' guarantees wraparound visits the other two tracks regardless
    // of where the (real, unseeded) shuffle happens to place the current one.
    player.setLoopMode('all');
    player.setShuffle(true);
    const seen = new Set<string | null>();
    seen.add(player.getState().currentFileId);
    await player.next();
    seen.add(player.getState().currentFileId);
    await player.next();
    seen.add(player.getState().currentFileId);
    expect(seen.size).toBe(3);
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('PlaylistPlayer normalization gain (Stage 5)', () => {
  it('applies resolveGain() to the source when a track starts playing', async () => {
    const engine = new FakeAudioEngine();
    const gainsByFileId: Record<string, number> = { a: 0.5, b: 2 };
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      resolveGain: (fileId) => gainsByFileId[fileId] ?? 1,
    });

    await player.setPlaylist(TRACKS); // starts on 'a'
    await flush();

    expect(engine.gainBySourceId.get(engine.lastSourceId!)).toBe(0.5);

    await player.next();
    await flush();

    expect(engine.gainBySourceId.get(engine.lastSourceId!)).toBe(2);
  });

  it('defaults to gain 1 when no resolveGain is given', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));

    await player.setPlaylist(TRACKS);
    await flush();

    expect(engine.gainBySourceId.get(engine.lastSourceId!)).toBe(1);
  });

  it('falls back to gain 1 instead of failing playback if resolveGain throws', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      resolveGain: () => {
        throw new Error('lookup failed');
      },
    });

    await player.setPlaylist(TRACKS);
    await flush();

    expect(player.getState().track.status).toBe('playing');
    expect(engine.gainBySourceId.get(engine.lastSourceId!)).toBe(1);
  });
});
