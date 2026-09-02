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

function makeAnalysis(fileId: string, bpm: number, gain = 1): AnalysisResult {
  return {
    fileId,
    startWindow: { bpm, bpmConfidence: 0.9, beatAnchorSeconds: 0 },
    endWindow: { bpm, bpmConfidence: 0.9, beatAnchorSeconds: 0 },
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

describe('PlaylistPlayer BPM-matched crossfade (Stage 7)', () => {
  const analysisByFileId: Record<string, AnalysisResult> = {
    a: makeAnalysis('a', 120, 1),
    b: makeAnalysis('b', 128, 0.8),
    c: makeAnalysis('c', 100, 1),
  };

  function makePlayer(engine: FakeAudioEngine, extraOptions: Record<string, unknown> = {}): PlaylistPlayer {
    return new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      resolveAnalysis: (fileId) => analysisByFileId[fileId],
      resolveGain: (fileId) => analysisByFileId[fileId]?.normalizationGain ?? 1,
      crossfadeSeconds: 5,
      ...extraOptions,
    });
  }

  it("schedules a real transition (rate/gain ramps on the outgoing source, a new started source for the incoming one) once the track is near its end and the next one is already preloaded", async () => {
    const engine = new FakeAudioEngine();
    engine.durationSecondsByFileId.a = 300; // long enough to fit the ramp phase (RAMP_DURATION_SECONDS=20) comfortably before the fade
    const player = makePlayer(engine);
    await player.setPlaylist(TRACKS); // playing 'a' on source-0
    await flush();
    player.checkPreload(); // 'a' is 300s long, so 'b' (the nearest preload slot) isn't within its own retry thresholds [60,50,40,35] yet at position 0
    await flush();

    // Cross the preload scheduler's nearest-slot threshold first, so 'b' is
    // actually ready by the time the crossfade trigger below checks for it.
    engine.clock = 245; // remaining 55s - within the [60,50,40,35] retry thresholds
    player.checkPreload();
    await flush();

    // 'a' is 120bpm, 'b' (next) is 128bpm - 'a' needs to speed up (targetRate
    // 128/120=1.0667), so a ramp is expected. Nominal ramp start accounts
    // for track-time consumed at the ramp's averaged rate and the fade's
    // held rate: 300 - (20*(1+1.0667)/2 + 5*1.0667) = 300 - 26 = 274,
    // beat-snapped (anchor 0, period 0.5) -> stays 274.
    engine.clock = 274; // remaining (26s) within RAMP_DURATION_SECONDS(20) + crossfadeSeconds(5) + lead(1)
    player.checkPreload();
    await flush();

    expect(engine.rateRampsBySourceId.get('source-0')?.length).toBe(1); // the outgoing source's rate ramp
    const rateRamp = engine.rateRampsBySourceId.get('source-0')?.[0];
    expect(rateRamp?.atTimeSeconds).toBeCloseTo(274, 6);
    expect(rateRamp?.durationSeconds).toBe(20);

    const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
    const fadeWhen = outgoingCurve?.atTimeSeconds ?? 0;
    expect(fadeWhen).toBeGreaterThan(274 + 20); // strictly after the ramp completes
    expect(outgoingCurve?.durationSeconds).toBe(5);
    expect(outgoingCurve?.values[0]).toBeCloseTo(1, 6); // equal-power fade-out starts at full volume
    expect(outgoingCurve?.values[outgoingCurve.values.length - 1]).toBeCloseTo(0, 6); // ...and ends silent
    const incomingStart = engine.scheduleStartCalls.find((call) => call.sourceId !== 'source-0');
    expect(incomingStart).toBeDefined(); // a new source was started for 'b'
    expect(incomingStart?.whenSeconds).toBeCloseTo(fadeWhen, 6);

    // Still reporting 'a' as current - the transition hasn't completed yet.
    expect(player.getState().currentFileId).toBe('a');
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

  it('does not schedule a crossfade without resolveAnalysis - falls back to the existing hard cut on natural end', async () => {
    const engine = new FakeAudioEngine();
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId)); // no resolveAnalysis
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();

    expect(engine.gainCurvesBySourceId.get('source-0')).toBeUndefined();
    expect(engine.rateRampsBySourceId.get('source-0')).toBeUndefined();
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

  it("falls back to a plain (rate-unchanged) fade when a track's BPM is unusable, instead of skipping the crossfade entirely", async () => {
    const engine = new FakeAudioEngine();
    const unusableAnalysis: Record<string, AnalysisResult> = {
      a: makeAnalysis('a', 0, 1), // unanalyzable BPM
      b: makeAnalysis('b', 128, 0.8),
      c: makeAnalysis('c', 100, 1),
    };
    const player = new PlaylistPlayer(engine, (fileId) => makeFileRef(fileId), {
      resolveAnalysis: (fileId) => unusableAnalysis[fileId],
      resolveGain: (fileId) => unusableAnalysis[fileId]?.normalizationGain ?? 1,
      crossfadeSeconds: 5,
    });
    await player.setPlaylist(TRACKS);
    await flush();
    player.checkPreload();
    await flush();

    engine.clock = 5;
    player.checkPreload();
    await flush();

    // Gain still fades out even with an unusable BPM (computeTransitionPlan's
    // existing bpm<=0 fallback) - and since neither side needs to change
    // tempo, no rate ramp is scheduled at all (not even a pointless "ramp to 1").
    const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
    expect(outgoingCurve?.atTimeSeconds).toBe(5);
    expect(outgoingCurve?.durationSeconds).toBe(5);
    expect(outgoingCurve?.values[0]).toBeCloseTo(1, 6);
    expect(outgoingCurve?.values[outgoingCurve.values.length - 1]).toBeCloseTo(0, 6);
    expect(engine.rateRampsBySourceId.get('source-0')).toBeUndefined();
  });
});
