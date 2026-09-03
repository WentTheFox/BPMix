import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine, DecodedAudio, RampSpec, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import { ANALYSIS_ALGORITHM_VERSION } from '../analysis/analyzeTrack';
import type { AnalysisResult } from '../library-store/types';
import { PlaylistPlayer } from './playlistPlayer';

class FakeAudioEngine implements AudioEngine {
  clock = 0;
  private nextId = 0;
  private endedCallbacks = new Map<string, () => void>();
  /** id of the most recently created source, so tests can fire its ended callback without tracking ids by hand. */
  lastSourceId: string | null = null;
  gainBySourceId = new Map<string, number>();
  gainRampsBySourceId = new Map<string, RampSpec[]>();
  rateRampsBySourceId = new Map<string, RampSpec[]>();
  gainCurvesBySourceId = new Map<string, Array<{ values: number[]; atTimeSeconds: number; durationSeconds: number }>>();
  scheduleStartCalls: Array<{ sourceId: string; whenSeconds: number; offsetSeconds?: number }> = [];
  decodedFileIds: string[] = [];
  /** Per-fileId override for decodeFile()'s returned duration - defaults to 10s. */
  durationSecondsByFileId: Record<string, number> = {};
  /** Simulates a real native scheduling conflict on the crossfade's gain curve call. */
  throwOnRampGainCurve = false;

  async decodeFile(ref: FileRef): Promise<DecodedAudio> {
    this.decodedFileIds.push(ref.id);
    return {
      sampleRate: 44100,
      numberOfChannels: 2,
      channelData: [],
      durationSeconds: this.durationSecondsByFileId[ref.id] ?? 10,
    };
  }

  createSource(_audio: DecodedAudio, onEnded?: () => void): SourceNode {
    const id = `source-${this.nextId++}`;
    this.lastSourceId = id;
    if (onEnded) this.endedCallbacks.set(id, onEnded);
    return {
      id,
      setGain: (value) => this.gainBySourceId.set(id, value),
      rampGain: (ramp) => {
        this.gainRampsBySourceId.set(id, [...(this.gainRampsBySourceId.get(id) ?? []), ramp]);
      },
      rampGainCurve: (values, atTimeSeconds, durationSeconds) => {
        if (this.throwOnRampGainCurve) {
          throw new Error('NotSupportedError: Cannot schedule event of type SetValueAtTime because it conflicts with an existing curve event');
        }
        this.gainCurvesBySourceId.set(id, [
          ...(this.gainCurvesBySourceId.get(id) ?? []),
          { values, atTimeSeconds, durationSeconds },
        ]);
      },
      setRate: () => {},
      rampRate: (ramp) => {
        this.rateRampsBySourceId.set(id, [...(this.rateRampsBySourceId.get(id) ?? []), ramp]);
      },
      stop: () => {},
    };
  }

  scheduleStart(source: SourceNode, whenSeconds: number, offsetSeconds?: number): void {
    this.scheduleStartCalls.push({ sourceId: source.id, whenSeconds, offsetSeconds });
  }

  now(): number {
    return this.clock;
  }

  fireEndedOnCurrentSource(): void {
    if (this.lastSourceId) this.endedCallbacks.get(this.lastSourceId)?.();
  }

  fireEnded(sourceId: string): void {
    this.endedCallbacks.get(sourceId)?.();
  }
}

function makeAnalysis(fileId: string, gain = 1): AnalysisResult {
  return {
    fileId,
    normalizationGain: gain,
    analyzedAtMs: 0,
    sizeBytes: 0,
    lastModifiedMs: 0,
    algorithmVersion: ANALYSIS_ALGORITHM_VERSION,
  };
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
    // setPlaylist(..., 'c') rather than two manual next() calls: manual
    // next() now crossfades (see "manual next()/previous() crossfades
    // instead of hard-cutting" below), which - unlike a plain load+play -
    // doesn't map onto fireEndedOnCurrentSource()'s single-source model;
    // this test is specifically about the natural-end path, not skipping.
    await player.setPlaylist(TRACKS, 'c');
    engine.fireEndedOnCurrentSource();
    await flush();
    expect(player.getState().currentFileId).toBe('a');
  });

  it('loop "off" stops (does not advance) when the last track ends naturally', async () => {
    await player.setPlaylist(TRACKS, 'c'); // see the previous test's note on why not two next() calls
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

  it('getNextFileId() reports the track that would play next', async () => {
    expect(player.getNextFileId()).toBe('b'); // starts on 'a'

    await player.next();
    expect(player.getNextFileId()).toBe('c');
  });

  it('getNextFileId() is null at the end of the playlist with loop off', async () => {
    await player.next();
    await player.next(); // now on 'c', the last track

    expect(player.getNextFileId()).toBeNull();
  });

  it('getNextFileId() wraps to the first track when looping all', async () => {
    player.setLoopMode('all');
    await player.next();
    await player.next(); // now on 'c'

    expect(player.getNextFileId()).toBe('a');
  });

  it('getNextFileId() is null while looping the current track', () => {
    player.setLoopMode('one');

    expect(player.getNextFileId()).toBeNull();
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

    // Manual next() crossfades (see "manual next()/previous() crossfades
    // instead of hard-cutting" below): the incoming source starts silent
    // (setGain(0)) and ramps up via a gain curve, not a single setGain()
    // call, so the resolved gain shows up as the curve's final value here.
    const incomingCurve = engine.gainCurvesBySourceId.get(engine.lastSourceId!)?.[0];
    expect(incomingCurve?.values[incomingCurve.values.length - 1]).toBeCloseTo(2, 6);
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

describe('PlaylistPlayer lookahead preload (Stage 6)', () => {
  it('checkPreload() decodes upcoming tracks ahead of time', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS); // starts on 'a'
    await flush();
    expect(engine.decodedFileIds).toEqual(['a']);

    player.checkPreload();
    await flush();

    // depth 2: both 'b' and 'c' get preloaded ahead of 'a' finishing.
    expect(engine.decodedFileIds).toEqual(['a', 'b', 'c']);
  });

  it('advancing to a preloaded track does not decode it again', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();
    expect(engine.decodedFileIds).toEqual(['a', 'b', 'c']);

    await player.next(); // -> 'b', already preloaded
    await flush();
    expect(engine.decodedFileIds).toEqual(['a', 'b', 'c']); // no new decode

    await player.next(); // -> 'c', already preloaded
    await flush();
    expect(engine.decodedFileIds).toEqual(['a', 'b', 'c']); // still no new decode
    expect(player.getState().currentFileId).toBe('c');
  });

  it('does nothing when nothing is playing or paused', () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    // No setPlaylist() call - order is empty, nothing playing.

    expect(() => player.checkPreload()).not.toThrow();
    expect(engine.decodedFileIds).toEqual([]);
  });

  it('does not preload anything while looping the current track', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS);
    await flush();
    player.setLoopMode('one');

    player.checkPreload();
    await flush();

    expect(engine.decodedFileIds).toEqual(['a']); // no preload beyond the current track
  });
});

describe('PlaylistPlayer just-in-time analysis hook (Stage 4 revision)', () => {
  it('fires onDecoded for the current track on first play, without blocking playback', async () => {
    const engine = new FakeAudioEngine();
    const onDecoded = vi.fn();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), { onDecoded });

    await player.setPlaylist(TRACKS);
    await flush();

    expect(player.getState().track.status).toBe('playing'); // not blocked on onDecoded
    expect(onDecoded).toHaveBeenCalledTimes(1);
    expect(onDecoded.mock.calls[0]![0]).toMatchObject({ id: 'a' });
  });

  it('fires onDecoded for tracks the preload scheduler decodes ahead of time', async () => {
    const engine = new FakeAudioEngine();
    const onDecoded = vi.fn();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), { onDecoded });

    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    const decodedIds = onDecoded.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(decodedIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not let a throwing onDecoded affect playback', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      onDecoded: () => {
        throw new Error('analysis blew up');
      },
    });

    await player.setPlaylist(TRACKS);
    await flush();

    expect(player.getState().track.status).toBe('playing');
    expect(player.getState().currentFileId).toBe('a');
  });
});

describe('PlaylistPlayer volume-only crossfade', () => {
  const analysisByFileId: Record<string, AnalysisResult> = {
    a: makeAnalysis('a', 1),
    b: makeAnalysis('b', 0.8),
    c: makeAnalysis('c', 1),
  };

  function makePlayer(engine: FakeAudioEngine, extraOptions: Record<string, unknown> = {}): PlaylistPlayer {
    return new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      resolveGain: (fileId) => analysisByFileId[fileId]?.normalizationGain ?? 1,
      crossfadeSeconds: 5,
      ...extraOptions,
    });
  }

  it('schedules a real transition (equal-power gain curves, a new started source for the incoming one) once the track is near its end and the next one is already preloaded - with no rate change on either side', async () => {
    const engine = new FakeAudioEngine();
    const player = makePlayer(engine);
    await player.setPlaylist(TRACKS); // playing 'a' on source-0
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5; // remaining 5s - within crossfadeSeconds(5) + lead(1)
    player.checkPreload();
    await flush();

    const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
    expect(outgoingCurve?.atTimeSeconds).toBe(5); // starts essentially immediately, no ramp/wait phase
    expect(outgoingCurve?.durationSeconds).toBe(5);
    expect(outgoingCurve?.values[0]).toBeCloseTo(1, 6); // 'a's own gain is 1, so the fade-out starts at full volume
    expect(outgoingCurve?.values[outgoingCurve.values.length - 1]).toBeCloseTo(0, 6); // ...and ends silent
    expect(engine.rateRampsBySourceId.get('source-0')).toBeUndefined(); // no rate change this round

    const incomingStart = engine.scheduleStartCalls.find((call) => call.sourceId !== 'source-0');
    expect(incomingStart).toBeDefined(); // a new source was started for 'b'
    expect(incomingStart?.whenSeconds).toBeCloseTo(5, 6);

    // Still reporting 'a' as current - the transition hasn't completed yet.
    expect(player.getState().currentFileId).toBe('a');
  });

  it("scales the outgoing gain curve by the outgoing track's own normalization gain (regression: the curve used to jump straight to raw 1.0 regardless of the track's actual current gain)", async () => {
    const engine = new FakeAudioEngine();
    const gainedAnalysis: Record<string, AnalysisResult> = {
      a: makeAnalysis('a', 0.57),
      b: makeAnalysis('b', 1),
      c: makeAnalysis('c', 1),
    };
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      resolveGain: (fileId) => gainedAnalysis[fileId]?.normalizationGain ?? 1,
      crossfadeSeconds: 5,
    });
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();

    const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
    expect(outgoingCurve?.values[0]).toBeCloseTo(0.57, 6); // continues from 'a's actual gain, not a bare 1.0
  });

  it('setCrossfadeSeconds() changes the duration used for the next transition (e.g. a live UI slider)', async () => {
    const engine = new FakeAudioEngine();
    const player = makePlayer(engine); // crossfadeSeconds: 5 initially
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    expect(player.getCrossfadeSeconds()).toBe(5);
    player.setCrossfadeSeconds(2);
    expect(player.getCrossfadeSeconds()).toBe(2);

    engine.clock = 8; // remaining 2s - within the new 2s crossfadeSeconds + 1s lead, but NOT the old 5s+1s
    player.checkPreload();
    await flush();

    const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
    expect(outgoingCurve?.durationSeconds).toBe(2); // used the updated duration, not the constructor's original 5
  });

  it('advances currentFileId/position only once the scheduled transition actually completes, not when it starts', async () => {
    const engine = new FakeAudioEngine();
    const player = makePlayer(engine);
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();
    expect(player.getState().currentFileId).toBe('a'); // mid-transition

    engine.fireEnded('source-0'); // the outgoing source's scheduled stop firing
    expect(player.getState().currentFileId).toBe('b');
    expect(player.getState().position).toBe(1);
    expect(player.getState().track.status).toBe('playing'); // kept playing straight through, no hard cut
  });

  it('schedules a crossfade even without a resolveGain option - no longer conditional on any analysis lookup succeeding', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), { crossfadeSeconds: 5 }); // no resolveGain
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();

    expect(engine.gainCurvesBySourceId.get('source-0')).toBeDefined();
  });

  it('does not schedule a crossfade before the next track has finished preloading', async () => {
    const engine = new FakeAudioEngine();
    const player = makePlayer(engine);
    await player.setPlaylist(TRACKS);
    await flush();
    // Deliberately no checkPreload() call yet - 'b' hasn't started preloading.

    engine.clock = 5; // already within the crossfade window
    player.checkPreload(); // starts preloading 'b' AND evaluates the crossfade trigger in the same tick, but the decode is async - 'b' can't be ready yet

    expect(engine.gainCurvesBySourceId.get('source-0')).toBeUndefined(); // nothing scheduled - fell through to the not-ready-yet fallback
  });

  it('never double-triggers a crossfade for the same track across repeated ticks', async () => {
    const engine = new FakeAudioEngine();
    const player = makePlayer(engine);
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();
    const rampCountAfterFirstTrigger = engine.gainCurvesBySourceId.get('source-0')?.length ?? 0;
    expect(rampCountAfterFirstTrigger).toBe(1);

    // Further ticks before the transition completes must not re-trigger it.
    player.checkPreload();
    player.checkPreload();
    await flush();
    expect(engine.gainCurvesBySourceId.get('source-0')?.length ?? 0).toBe(1);
  });

  it("does not retry-storm a repeatable scheduling failure (regression: a real 'conflicts with an existing curve event' error was seen on-device, then the SAME transition retried every ~200ms tick, each attempt scheduling another conflicting automation on top of the last - reading as escalating, erratic pitch/tempo glitches)", async () => {
    const engine = new FakeAudioEngine();
    engine.throwOnRampGainCurve = true;
    const onError = vi.fn();
    const player = makePlayer(engine, { onError });
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();

    expect(onError).toHaveBeenCalledTimes(1); // the failure was reported once...

    // ...and must not be retried on subsequent ticks - each retry would
    // schedule another conflicting automation on the same still-playing
    // outgoing source, compounding rather than just failing once.
    player.checkPreload();
    player.checkPreload();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

});

describe('PlaylistPlayer manual next()/previous() crossfades instead of hard-cutting', () => {
  it('schedules a short (not the full crossfadeSeconds) crossfade into the target track, and updates currentFileId immediately rather than waiting for it to complete', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), { crossfadeSeconds: 5 });
    await player.setPlaylist(TRACKS); // playing 'a' on source-0
    await flush();

    await player.next();
    await flush();

    expect(player.getState().currentFileId).toBe('b'); // reflects the target immediately, same as playAt() does
    expect(player.getState().track.status).toBe('playing'); // still audibly playing throughout - not stuck "loading"

    const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
    expect(outgoingCurve?.durationSeconds).toBeLessThan(5); // much shorter than the natural end-of-track crossfadeSeconds
    expect(engine.scheduleStartCalls.some((call) => call.sourceId !== 'source-0')).toBe(true); // a new source was started for 'b'
  });

  it('actually completes the transition once the outgoing source is fully faded out', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS);
    await flush();

    await player.next();
    await flush();
    expect(player.getState().currentFileId).toBe('b');

    engine.fireEnded('source-0'); // the outgoing source's scheduled stop firing
    expect(player.getState().track.status).toBe('playing'); // swapped straight through, no hard cut/reload
    expect(player.getState().position).toBe(1); // position bookkeeping wasn't double-advanced by handleCrossfadeCompleted
  });

  it('falls back to a plain hard cut when nothing is currently playing to crossfade away from', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS);
    await flush();
    player.pause();

    await player.next();
    await flush();

    expect(player.getState().currentFileId).toBe('b');
    expect(engine.gainCurvesBySourceId.size).toBe(0); // no crossfade gain curve was ever scheduled
  });

  it("exposes pendingCrossfadeFileIds correctly during the crossfade, despite currentFileId/getNextFileId() already having moved past it (regression: those two mean something different here than for the natural end-of-track crossfade, since a manual skip advances `position` immediately instead of waiting for completion)", async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId));
    await player.setPlaylist(TRACKS); // playing 'a'
    await flush();

    await player.next(); // crossfading 'a' -> 'b'
    await flush();

    expect(player.getState().pendingCrossfadeFileIds).toEqual({ outgoing: 'a', incoming: 'b' });
    expect(player.getState().currentFileId).toBe('b'); // already the target, NOT the outgoing side
    expect(player.getState().position).toBe(1);

    engine.fireEnded('source-0'); // the crossfade actually completes
    expect(player.getState().pendingCrossfadeFileIds).toBeNull();
  });
});
