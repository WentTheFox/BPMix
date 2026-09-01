import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import { TrackPlayer } from './trackPlayer';

class FakeAudioEngine implements AudioEngine {
  clock = 0;
  stoppedSourceIds: string[] = [];
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
      },
    };
  }

  scheduleStart(): void {}

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
});
