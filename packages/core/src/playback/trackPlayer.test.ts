import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioEngine, DecodedAudio, RampSpec, SourceNode } from '../audio-engine/types';
import type { TransitionPlan } from '../crossfade/computeTransitionPlan';
import type { FileRef } from '../file-access/types';
import { TrackPlayer } from './trackPlayer';

class FakeAudioEngine implements AudioEngine {
  clock = 0;
  stoppedSourceIds: string[] = [];
  /** whenSeconds passed to a scheduled (future) stop() call, keyed by source id - undefined for an immediate stop(). */
  stopWhenBySourceId = new Map<string, number | undefined>();
  gainBySourceId = new Map<string, number>();
  gainRampsBySourceId = new Map<string, RampSpec[]>();
  rateRampsBySourceId = new Map<string, RampSpec[]>();
  gainCurvesBySourceId = new Map<string, Array<{ values: number[]; atTimeSeconds: number; durationSeconds: number }>>();
  setRateCallsBySourceId = new Map<string, number[]>();
  scheduleStartCalls: Array<{ sourceId: string; whenSeconds: number; offsetSeconds?: number }> = [];
  /**
   * Some real native audio engines (confirmed: react-native-audio-api on
   * Android) invoke a source's onEnded callback SYNCHRONOUSLY from within
   * stop() - unlike the browser, where it's always async. Enable this to
   * reproduce that in tests.
   */
  fireEndedSynchronouslyOnStop = false;
  /** Simulates the engine synchronously rejecting a start (e.g. native throwing on a non-finite offset). */
  throwOnScheduleStart = false;
  /** Simulates a real conflict (e.g. "conflicts with an existing curve event") on the *incoming* source's rampGainCurve call, after the outgoing source's own scheduling already succeeded. */
  throwOnIncomingRampGainCurve = false;
  private nextId = 0;
  private endedCallbacks = new Map<string, () => void>();
  decodeCallCount = 0;

  async decodeFile(_ref: FileRef): Promise<DecodedAudio> {
    this.decodeCallCount++;
    return { sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 10 };
  }

  createSource(_audio: DecodedAudio, onEnded?: () => void): SourceNode {
    const id = `source-${this.nextId++}`;
    if (onEnded) this.endedCallbacks.set(id, onEnded);
    return {
      id,
      setGain: (value) => this.gainBySourceId.set(id, value),
      rampGain: (ramp) => {
        this.gainRampsBySourceId.set(id, [...(this.gainRampsBySourceId.get(id) ?? []), ramp]);
      },
      rampGainCurve: (values, atTimeSeconds, durationSeconds) => {
        if (this.throwOnIncomingRampGainCurve && id !== 'source-0') {
          throw new Error(
            'NotSupportedError: Cannot schedule event of type SetValueAtTime because it conflicts with an existing curve event',
          );
        }
        this.gainCurvesBySourceId.set(id, [
          ...(this.gainCurvesBySourceId.get(id) ?? []),
          { values, atTimeSeconds, durationSeconds },
        ]);
      },
      setRate: (value) => {
        this.setRateCallsBySourceId.set(id, [...(this.setRateCallsBySourceId.get(id) ?? []), value]);
      },
      rampRate: (ramp) => {
        this.rateRampsBySourceId.set(id, [...(this.rateRampsBySourceId.get(id) ?? []), ramp]);
      },
      stop: (whenSeconds) => {
        this.stoppedSourceIds.push(id);
        this.stopWhenBySourceId.set(id, whenSeconds);
        if (this.fireEndedSynchronouslyOnStop) {
          this.endedCallbacks.get(id)?.();
        }
      },
    };
  }

  scheduleStart(source: SourceNode, whenSeconds: number, offsetSeconds?: number): void {
    if (this.throwOnScheduleStart) {
      throw new TypeError('The provided double value is non-finite.');
    }
    this.scheduleStartCalls.push({ sourceId: source.id, whenSeconds, offsetSeconds });
  }

  now(): number {
    return this.clock;
  }

  /** Test helper: simulate a source naturally reaching the end of its buffer (or a scheduled stop() firing). */
  fireEnded(sourceId: string): void {
    this.endedCallbacks.get(sourceId)?.();
  }
}

const fileRef: FileRef = { id: 'f1', name: 'track.mp3', relativePath: 'track.mp3', sizeBytes: 0, lastModifiedMs: 0 };

describe('TrackPlayer', () => {
  let engine: FakeAudioEngine;
  let player: TrackPlayer;

  beforeEach(async () => {
    engine = new FakeAudioEngine();
    player = new TrackPlayer(engine);
    await player.load(fileRef);
  });

  it('starts stopped with the decoded duration and zero position', () => {
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 0, durationSeconds: 10, pendingIncoming: null, rewinding: null });
  });

  it('play() advances position with the engine clock', () => {
    player.play();
    engine.clock = 3;
    expect(player.getState()).toEqual({ status: 'playing', positionSeconds: 3, durationSeconds: 10, pendingIncoming: null, rewinding: null });
  });

  it('pause() freezes position and stops the underlying source', () => {
    player.play();
    engine.clock = 4;
    player.pause();
    engine.clock = 10; // should have no further effect while paused
    expect(player.getState()).toEqual({ status: 'paused', positionSeconds: 4, durationSeconds: 10, pendingIncoming: null, rewinding: null });
    expect(engine.stoppedSourceIds).toEqual(['source-0']);
  });

  it('play() after pause() resumes from the paused position', () => {
    player.play();
    engine.clock = 4;
    player.pause();
    engine.clock = 5;
    player.play();
    engine.clock = 7;
    expect(player.getState().positionSeconds).toBe(6); // 4 + (7 - 5)
  });

  it('pause() fades the outgoing source out and schedules its stop, rather than cutting it immediately', () => {
    player.play(); // source-0
    engine.clock = 4;
    player.pause();

    expect(engine.gainRampsBySourceId.get('source-0')).toEqual([{ toValue: 0, atTimeSeconds: 4, durationSeconds: 0.5 }]);
    // Scheduled in the future (fade duration + the stop-tail cushion), not an immediate cutoff.
    expect(engine.stopWhenBySourceId.get('source-0')).toBeCloseTo(4.7, 6);
  });

  it('play() after pause() fades the resumed source back in, but a fresh (non-resume) play() does not', () => {
    player.play(); // source-0 - a fresh start, no fade-in
    expect(engine.gainRampsBySourceId.get('source-0')).toBeUndefined();

    engine.clock = 4;
    player.pause();
    engine.clock = 5;
    player.play(); // source-1 - resuming from pause, fades in

    expect(engine.gainRampsBySourceId.get('source-1')).toEqual([{ toValue: 1, atTimeSeconds: 5, durationSeconds: 0.5 }]);
  });

  it('seek() while playing restarts playback from the new offset', () => {
    player.play();
    engine.clock = 2;
    player.seek(8);
    expect(player.getState().positionSeconds).toBe(8);
    engine.clock = 3;
    expect(player.getState().positionSeconds).toBe(9);
    expect(engine.stoppedSourceIds).toEqual(['source-0']);
  });

  it('seek() while paused updates position without starting playback', () => {
    player.play();
    player.pause();
    player.seek(6);
    expect(player.getState()).toEqual({ status: 'paused', positionSeconds: 6, durationSeconds: 10, pendingIncoming: null, rewinding: null });
  });

  it('stop() resets position to zero', () => {
    player.play();
    engine.clock = 5;
    player.stop();
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 0, durationSeconds: 10, pendingIncoming: null, rewinding: null });
  });

  it('transitions to stopped when the source reports it ended naturally', () => {
    player.play();
    engine.fireEnded('source-0');
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 10, durationSeconds: 10, pendingIncoming: null, rewinding: null });
  });

  it('ignores an ended callback from a source already superseded by seek/pause', () => {
    player.play();
    player.pause(); // stops source-0
    player.play(); // creates source-1
    engine.fireEnded('source-0'); // stale callback from the old source
    expect(player.getState().status).toBe('playing');
  });

  it('fires onEnded when the track finishes naturally, but not on explicit stop/pause/seek', async () => {
    const ended: number[] = [];
    const callbackEngine = new FakeAudioEngine();
    const callbackPlayer = new TrackPlayer(callbackEngine, { onEnded: () => ended.push(ended.length) });
    await callbackPlayer.load(fileRef);

    callbackPlayer.play();
    callbackPlayer.pause();
    callbackPlayer.play();
    callbackPlayer.seek(2);
    callbackPlayer.stop();
    expect(ended).toEqual([]);

    callbackPlayer.play();
    // 4 sources created above (play, play-after-pause, seek's restart, play-after-stop); this is the active one.
    callbackEngine.fireEnded('source-3');
    expect(ended).toEqual([0]);
  });

  it('does not treat an engine that fires onEnded synchronously from stop() as a natural end', async () => {
    // Regression test: a real crash on Android traced back to exactly this -
    // stop() firing onEnded synchronously, and the old this.source?.stop();
    // this.source = null; ordering meant the "is this source stale" guard
    // in handleEnded still saw this.source pointing at the source being
    // intentionally stopped, so it ran as if the track had ended naturally.
    const ended: number[] = [];
    const syncEngine = new FakeAudioEngine();
    syncEngine.fireEndedSynchronouslyOnStop = true;
    const syncPlayer = new TrackPlayer(syncEngine, { onEnded: () => ended.push(ended.length) });
    await syncPlayer.load(fileRef);

    syncPlayer.play();
    syncPlayer.pause();
    syncPlayer.play();
    for (let i = 0; i < 20; i++) {
      syncPlayer.seek(i % 5); // rapid repeated seeking, as triggered the real crash
    }
    syncPlayer.stop();

    expect(ended).toEqual([]);
    expect(syncPlayer.getState().status).toBe('stopped');
  });

  it('seek() ignores non-finite input instead of propagating NaN to the engine', () => {
    player.play();
    engine.clock = 3;
    player.seek(Number.NaN);
    player.seek(Number.POSITIVE_INFINITY);
    // Unaffected - both calls were no-ops.
    expect(player.getState()).toEqual({ status: 'playing', positionSeconds: 3, durationSeconds: 10, pendingIncoming: null, rewinding: null });
  });

  it('recovers instead of getting stuck if the engine rejects a start (e.g. throws on a bad offset)', async () => {
    // Regression test: this traced back to a real "playback just stops and
    // never advances" report. The engine had already thrown once during
    // this exact session from a genuinely-buggy seek-bar coordinate
    // calculation (since fixed) - but even with that fixed, nothing should
    // ever leave TrackPlayer claiming status='playing' for a source that
    // was never actually started, since nothing would ever fire its
    // onEnded and the player would be stuck on that track forever.
    const ended: number[] = [];
    const throwingEngine = new FakeAudioEngine();
    const throwingPlayer = new TrackPlayer(throwingEngine, { onEnded: () => ended.push(ended.length) });
    await throwingPlayer.load(fileRef);

    throwingEngine.throwOnScheduleStart = true;
    throwingPlayer.play();

    expect(throwingPlayer.getState().status).toBe('stopped');
    expect(ended).toEqual([0]); // treated as an immediate natural end, so a playlist can move on

    // And the player still works normally afterwards - not permanently
    // wedged. (handleEnded left position at the track's end, same as any
    // natural end would - seeking back and playing again is a fresh start.)
    throwingEngine.throwOnScheduleStart = false;
    throwingPlayer.seek(0);
    throwingPlayer.play();
    expect(throwingPlayer.getState().status).toBe('playing');
  });

  it('a stale load() resolving after a newer one must not corrupt the now-playing state', async () => {
    // Regression test found via rapid-fire track-skip stress testing on
    // Android: two overlapping load() calls (e.g. two fast next-track taps)
    // don't necessarily decode in call order. If the FIRST call's decode
    // resolves AFTER the second one already finished and started playing,
    // the first call must not be allowed to silently overwrite
    // decoded/status out from under the track that's actually playing now.
    class ControllableEngine extends FakeAudioEngine {
      private resolvers: Array<(audio: DecodedAudio) => void> = [];
      override async decodeFile(_ref: FileRef): Promise<DecodedAudio> {
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      }
      resolve(index: number, durationSeconds: number): void {
        this.resolvers[index]?.({ sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds });
      }
    }

    const controllable = new ControllableEngine();
    const racingPlayer = new TrackPlayer(controllable);

    const staleLoad = racingPlayer.load({ ...fileRef, id: 'stale' });
    const freshLoad = racingPlayer.load({ ...fileRef, id: 'fresh' });

    controllable.resolve(1, 20); // the newer call's decode resolves first
    await freshLoad;
    racingPlayer.play();
    expect(racingPlayer.getState().status).toBe('playing');
    expect(racingPlayer.getState().durationSeconds).toBe(20);

    controllable.resolve(0, 10); // the stale call's decode finally resolves
    await staleLoad;

    expect(racingPlayer.getState().status).toBe('playing');
    expect(racingPlayer.getState().durationSeconds).toBe(20);
  });

  it('setGain() applies to the currently playing source immediately', () => {
    player.play();
    const [sourceId] = engine.gainBySourceId.keys();

    player.setGain(0.5);

    expect(engine.gainBySourceId.get(sourceId!)).toBe(0.5);
  });

  it('setGain() carries over to a source created later by seek/resume', () => {
    player.setGain(0.5);
    player.play(); // a fresh start (not a resume-from-pause), so no fade-in
    player.seek(3); // tears down the current source and creates a new one

    const gains = [...engine.gainBySourceId.values()];
    expect(gains.every((g) => g === 0.5)).toBe(true);
    expect(gains.length).toBeGreaterThanOrEqual(2); // the original source and the one seek() created
  });

  it('defaults to gain 1 (no change) when never set', () => {
    player.play(); // a fresh start (not a resume-from-pause), so no fade-in
    const [sourceId] = engine.gainBySourceId.keys();

    expect(engine.gainBySourceId.get(sourceId!)).toBe(1);
  });

  it('setVolume() multiplies with setGain() rather than replacing it, and applies to the currently playing source immediately', () => {
    player.setGain(0.5);
    player.play();

    player.setVolume(0.4);

    const [sourceId] = engine.gainBySourceId.keys();
    expect(engine.gainBySourceId.get(sourceId!)).toBeCloseTo(0.2, 6); // 0.5 * 0.4
    expect(player.getVolume()).toBe(0.4);
  });

  it('setVolume() carries over to a source created later by seek/resume, same as setGain()', () => {
    player.setVolume(0.5);
    player.play(); // a fresh start (not a resume-from-pause), so no fade-in
    player.seek(3);

    const gains = [...engine.gainBySourceId.values()];
    expect(gains.every((g) => g === 0.5)).toBe(true);
    expect(gains.length).toBeGreaterThanOrEqual(2);
  });

  it('clamps setVolume() to [0,1]', () => {
    player.play();

    player.setVolume(1.5);
    expect(player.getVolume()).toBe(1);

    player.setVolume(-0.5);
    expect(player.getVolume()).toBe(0);
  });

  it('loadDecoded() makes an already-decoded buffer playable without a decodeFile() round trip', () => {
    const decodeCallsBefore = engine.decodeCallCount;

    player.loadDecoded({ sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 30 });

    expect(engine.decodeCallCount).toBe(decodeCallsBefore); // no new decode
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 0, durationSeconds: 30, pendingIncoming: null, rewinding: null });

    player.play();
    expect(player.getState().status).toBe('playing');
  });

  it('loadDecoded() stops whatever was already playing first', () => {
    player.play();
    expect(player.getState().status).toBe('playing');

    player.loadDecoded({ sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 5 });

    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 0, durationSeconds: 5, pendingIncoming: null, rewinding: null });
  });

  it('loadDecoded() invalidates a still-in-flight async load(), like a newer load() would', () => {
    const controllable = new (class extends FakeAudioEngine {
      override decodeFile(): Promise<DecodedAudio> {
        return new Promise(() => {}); // never resolves
      }
    })();
    const racingPlayer = new TrackPlayer(controllable);
    const staleLoad = racingPlayer.load(fileRef);

    racingPlayer.loadDecoded({ sampleRate: 44100, numberOfChannels: 1, channelData: [], durationSeconds: 7 });

    expect(racingPlayer.getState().durationSeconds).toBe(7);
    void staleLoad; // deliberately never resolves - not awaited, just proving loadDecoded() doesn't wait on it either
  });

  describe('crossfadeTo', () => {
    const simplePlan: TransitionPlan = {
      fadeStartSeconds: 5,
      incomingStartSeconds: 1,
      fadeDurationSeconds: 3,
    };
    const nextDecoded: DecodedAudio = { sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 20 };

    it('is a no-op (returns false) if nothing is currently playing', () => {
      expect(player.crossfadeTo(nextDecoded, simplePlan, 1)).toBe(false);
      expect(engine.scheduleStartCalls).toEqual([]);
    });

    it('starts the fade essentially immediately (at now()), no ramp/wait phase, and starts a new source for the incoming track at rate 1', () => {
      player.play(); // source-0, started at clock=0, offset=0
      engine.clock = 5;
      engine.scheduleStartCalls = []; // clear the initial play()'s own scheduleStart call - only care about what crossfadeTo schedules

      const started = player.crossfadeTo(nextDecoded, simplePlan, 0.8);

      expect(started).toBe(true);
      expect(engine.rateRampsBySourceId.get('source-0')).toBeUndefined(); // no rate change this round

      // The gain fade (equal-power, not a single linear rampGain - see
      // equalPowerGain's doc) and the incoming source's start are both
      // scheduled for now() - "little to no delay".
      const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
      expect(outgoingCurve?.atTimeSeconds).toBe(5);
      expect(outgoingCurve?.durationSeconds).toBe(3);
      expect(outgoingCurve?.values[0]).toBeCloseTo(1, 6); // cos(0) * currentGain(1) - starts at full volume
      expect(outgoingCurve?.values[outgoingCurve.values.length - 1]).toBeCloseTo(0, 6); // cos(pi/2) - ends silent
      // A small STOP_TAIL_SECONDS cushion past the curve's own nominal end -
      // see its doc for why (a safety margin against the physical cutoff
      // landing before the ramp automation has actually finished).
      expect(engine.stopWhenBySourceId.get('source-0')).toBeCloseTo(5 + simplePlan.fadeDurationSeconds + 0.2, 6);

      expect(engine.scheduleStartCalls).toEqual([{ sourceId: 'source-1', whenSeconds: 5, offsetSeconds: 1 }]);
      expect(engine.gainBySourceId.get('source-1')).toBe(0); // starts silent
      expect(engine.setRateCallsBySourceId.get('source-1') ?? []).toEqual([]); // never set away from the default rate 1
      const incomingCurve = engine.gainCurvesBySourceId.get('source-1')?.[0];
      expect(incomingCurve?.atTimeSeconds).toBe(5);
      expect(incomingCurve?.values[incomingCurve.values.length - 1]).toBeCloseTo(0.8, 6); // sin(pi/2) * nextGain(0.8)
    });

    it("scales the outgoing gain curve by the outgoing track's own current gain, not a bare 1.0 (regression: this used to jump to raw cos(0)=1.0 regardless of the track's actual gain, an audible volume jump right as the fade began)", () => {
      player.play();
      player.setGain(0.57);
      engine.clock = 5;

      player.crossfadeTo(nextDecoded, simplePlan, 1);

      const outgoingCurve = engine.gainCurvesBySourceId.get('source-0')?.[0];
      expect(outgoingCurve?.values[0]).toBeCloseTo(0.57, 6);
    });

    it('keeps reporting the outgoing track until its scheduled stop actually fires, then swaps to the incoming track and fires onCrossfadeCompleted (not onEnded)', async () => {
      const ended: string[] = [];
      const crossfadeCompletions: number[] = [];
      const cfEngine = new FakeAudioEngine();
      const cfPlayer = new TrackPlayer(cfEngine, {
        onEnded: () => ended.push('ended'),
        onCrossfadeCompleted: () => crossfadeCompletions.push(crossfadeCompletions.length),
      });
      await cfPlayer.load(fileRef);
      cfPlayer.play(); // source-0
      cfEngine.clock = 5;
      cfPlayer.crossfadeTo(nextDecoded, simplePlan, 0.8); // schedules source-1, fadeWhen=5

      // Mid-transition: still reporting the outgoing track's own state, but
      // pendingIncoming exposes the incoming track's own live position too.
      cfEngine.clock = 6;
      expect(cfPlayer.getState()).toEqual({
        status: 'playing',
        positionSeconds: 6,
        durationSeconds: 10,
        pendingIncoming: { positionSeconds: 2, durationSeconds: 20, fadeDurationSeconds: 3 }, // incomingStartSeconds(1) + (now(6)-fadeWhen(5))*rate(1)
        rewinding: null,
      });
      expect(ended).toEqual([]);
      expect(crossfadeCompletions).toEqual([]);

      // The outgoing source's scheduled stop (at fadeWhen+fadeDuration+STOP_TAIL_SECONDS=8.2) fires.
      cfEngine.fireEnded('source-0');

      expect(ended).toEqual([]); // not a natural end - must not be reported as one
      expect(crossfadeCompletions).toEqual([0]);
      // positionSeconds = incomingStartSeconds(1) + (now(6) - fadeWhen(5)) * rate(1) = 1 + 1 = 2
      expect(cfPlayer.getState()).toEqual({ status: 'playing', positionSeconds: 2, durationSeconds: 20, pendingIncoming: null, rewinding: null });

      cfEngine.clock = 8;
      expect(cfPlayer.getState().positionSeconds).toBeCloseTo(1 + (8 - 5), 6);
    });

    it('cleans up (stops) the incoming source and re-throws, instead of leaving it dangling, if a scheduling call throws partway through', () => {
      // Regression: a real "conflicts with an existing curve event" error
      // was observed on-device. The bug wasn't the conflict itself so much
      // as what happened next - see playlistPlayer.test.ts's matching
      // regression test for the retry-storm this fix actually prevents.
      player.play();
      engine.clock = 5;
      engine.throwOnIncomingRampGainCurve = true;

      expect(() => player.crossfadeTo(nextDecoded, simplePlan, 1)).toThrow(/conflicts with an existing curve event/);

      expect(engine.stoppedSourceIds).toContain('source-1'); // the incoming source, cleaned up rather than left dangling
      // No pending crossfade was left behind either - source-0's own
      // (real) natural end must be treated as a real end, not misread as
      // a crossfade completion swap onto the source-1 that never actually
      // took over.
      engine.fireEnded('source-0');
      expect(player.getState().status).toBe('stopped');
    });

    it('cancels the incoming source too if the transition is interrupted by an explicit stop() before it completes', () => {
      player.play();
      engine.clock = 5;
      player.crossfadeTo(nextDecoded, simplePlan, 1);

      player.stop();

      expect(engine.stoppedSourceIds).toContain('source-1'); // the pending incoming source, not just the outgoing one
      expect(player.getState().status).toBe('stopped');

      // The outgoing source's originally-scheduled stop firing afterward must not resurrect anything.
      engine.fireEnded('source-0');
      expect(player.getState().status).toBe('stopped');
    });

    it('cancels a still-pending crossfade before scheduling a new one, rather than layering two on the same outgoing source (regression: rapid manual next/previous presses each schedule their own short crossfade)', () => {
      player.play(); // source-0
      engine.clock = 5;
      player.crossfadeTo(nextDecoded, simplePlan, 1); // schedules source-1 as the pending incoming source

      const secondDecoded: DecodedAudio = { sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 15 };
      player.crossfadeTo(secondDecoded, simplePlan, 1); // a second request before the first completed

      expect(engine.stoppedSourceIds).toContain('source-1'); // the first (now-stale) incoming source was cancelled
      expect(player.getState().pendingIncoming?.durationSeconds).toBe(15); // the second request's track, not the first's

      // Only the second incoming source's completion should resolve the transition.
      engine.fireEnded('source-0');
      expect(player.getState().durationSeconds).toBe(15);
    });
  });

  describe('rewindTo', () => {
    it('is a no-op while paused - nothing to play a reversed clip over', () => {
      player.play();
      player.pause();
      expect(player.rewindTo(0, 1)).toBe(false);
      expect(player.getState().rewinding).toBeNull();
    });

    it('is a no-op for a forward or negligible seek', () => {
      player.play();
      engine.clock = 5;
      expect(player.rewindTo(5, 1)).toBe(false); // same position
      expect(player.rewindTo(6, 1)).toBe(false); // forward
      expect(player.rewindTo(4.9, 1)).toBe(false); // under MIN_REWIND_SEGMENT_SECONDS
      expect(player.getState().rewinding).toBeNull();
    });

    it('is a no-op on an engine without real decoded PCM to reverse (Windows)', () => {
      class WindowsLikeEngine extends FakeAudioEngine {
        async awaitAnalysisReady(): Promise<void> {}
      }
      const winEngine = new WindowsLikeEngine();
      const winPlayer = new TrackPlayer(winEngine);
      return winPlayer.load(fileRef).then(() => {
        winPlayer.play();
        winEngine.clock = 5;
        expect(winPlayer.rewindTo(1, 1)).toBe(false);
      });
    });

    it('plays a reversed, sped-up source and reports position decreasing toward the target', () => {
      player.play(); // source-0
      engine.clock = 5;
      expect(player.rewindTo(2, 1)).toBe(true); // 3s segment sped up to fit 1s -> rate 3

      expect(engine.stoppedSourceIds).toEqual(['source-0']);
      expect(engine.setRateCallsBySourceId.get('source-1')).toEqual([3]);
      expect(player.getState().rewinding).toEqual({ fromSeconds: 5, toSeconds: 2, durationSeconds: 1 });

      // Halfway through the 1s rewind: halfway from 5 down to 2.
      engine.clock = 5.5;
      expect(player.getState().positionSeconds).toBeCloseTo(3.5, 6);
    });

    it('resumes normal forward playback from the target once the reversed clip ends', () => {
      player.play(); // source-0
      engine.clock = 5;
      player.rewindTo(2, 1); // source-1, 1s rewind

      engine.clock = 6; // the rewind's 1s has elapsed
      engine.fireEnded('source-1');

      const state = player.getState();
      expect(state.rewinding).toBeNull();
      expect(state.status).toBe('playing');
      expect(state.positionSeconds).toBe(2);

      // Playback continues forward normally from there.
      engine.clock = 8;
      expect(player.getState().positionSeconds).toBe(4);
    });

    it('clamps the rate for a very long rewind by stretching the effect duration instead', () => {
      // A long segment: rate would need to exceed MAX_REWIND_RATE(40) at the
      // requested 1.2s duration, so the effect's duration stretches instead.
      const longEngine = new FakeAudioEngine();
      const longPlayer = new TrackPlayer(longEngine);
      return longPlayer.load({ ...fileRef, id: 'f2' }).then(async () => {
        // Give it a much longer duration to seek back across.
        const decoded: DecodedAudio = { sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 200 };
        longPlayer.loadDecoded(decoded);
        longPlayer.play();
        longEngine.clock = 100;
        longPlayer.rewindTo(0, 1.2); // 100s segment / MAX_REWIND_RATE(40) = 2.5s actual duration, rate 40
        expect(longEngine.setRateCallsBySourceId.get('source-1')).toEqual([40]);
        expect(longPlayer.getState().rewinding?.durationSeconds).toBeCloseTo(2.5, 6);
      });
    });
  });
});
