import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import { TrackPlayer } from './trackPlayer';

class FakeAudioEngine implements AudioEngine {
  clock = 0;
  stoppedSourceIds: string[] = [];
  /**
   * Some real native audio engines (confirmed: react-native-audio-api on
   * Android) invoke a source's onEnded callback SYNCHRONOUSLY from within
   * stop() - unlike the browser, where it's always async. Enable this to
   * reproduce that in tests.
   */
  fireEndedSynchronouslyOnStop = false;
  /** Simulates the engine synchronously rejecting a start (e.g. native throwing on a non-finite offset). */
  throwOnScheduleStart = false;
  private nextId = 0;
  private endedCallbacks = new Map<string, () => void>();

  async decodeFile(_ref: FileRef): Promise<DecodedAudio> {
    return { sampleRate: 44100, numberOfChannels: 2, channelData: [], durationSeconds: 10 };
  }

  createSource(_audio: DecodedAudio, onEnded?: () => void): SourceNode {
    const id = `source-${this.nextId++}`;
    if (onEnded) this.endedCallbacks.set(id, onEnded);
    return {
      id,
      setGain: () => {},
      rampGain: () => {},
      setRate: () => {},
      rampRate: () => {},
      stop: () => {
        this.stoppedSourceIds.push(id);
        if (this.fireEndedSynchronouslyOnStop) {
          this.endedCallbacks.get(id)?.();
        }
      },
    };
  }

  scheduleStart(): void {
    if (this.throwOnScheduleStart) {
      throw new TypeError('The provided double value is non-finite.');
    }
  }

  now(): number {
    return this.clock;
  }

  /** Test helper: simulate a source naturally reaching the end of its buffer. */
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
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 0, durationSeconds: 10 });
  });

  it('play() advances position with the engine clock', () => {
    player.play();
    engine.clock = 3;
    expect(player.getState()).toEqual({ status: 'playing', positionSeconds: 3, durationSeconds: 10 });
  });

  it('pause() freezes position and stops the underlying source', () => {
    player.play();
    engine.clock = 4;
    player.pause();
    engine.clock = 10; // should have no further effect while paused
    expect(player.getState()).toEqual({ status: 'paused', positionSeconds: 4, durationSeconds: 10 });
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
    expect(player.getState()).toEqual({ status: 'paused', positionSeconds: 6, durationSeconds: 10 });
  });

  it('stop() resets position to zero', () => {
    player.play();
    engine.clock = 5;
    player.stop();
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 0, durationSeconds: 10 });
  });

  it('transitions to stopped when the source reports it ended naturally', () => {
    player.play();
    engine.fireEnded('source-0');
    expect(player.getState()).toEqual({ status: 'stopped', positionSeconds: 10, durationSeconds: 10 });
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
    expect(player.getState()).toEqual({ status: 'playing', positionSeconds: 3, durationSeconds: 10 });
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
});
