import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';

export type TrackPlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

export interface TrackPlayerState {
  status: TrackPlayerStatus;
  positionSeconds: number;
  durationSeconds: number;
}

/**
 * Play/pause/seek/stop on top of the engine's one-shot SourceNode primitive.
 * A SourceNode can't be paused or restarted once stopped, so this stops the
 * current source and creates a new one (at the resume/seek offset) whenever
 * playback needs to continue from somewhere other than "where it just was".
 */
export class TrackPlayer {
  private readonly engine: AudioEngine;
  private decoded: DecodedAudio | null = null;
  private source: SourceNode | null = null;
  private status: TrackPlayerStatus = 'idle';
  private startedAtEngineTime = 0;
  private startOffsetSeconds = 0;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  async load(ref: FileRef): Promise<void> {
    this.stop();
    this.status = 'loading';
    this.decoded = await this.engine.decodeFile(ref);
    this.startOffsetSeconds = 0;
    this.status = 'stopped';
  }

  play(): void {
    if (!this.decoded) {
      throw new Error('TrackPlayer.play() called before load() resolved');
    }
    if (this.status === 'playing') {
      return;
    }
    this.startPlaybackFrom(this.startOffsetSeconds);
  }

  pause(): void {
    if (this.status !== 'playing') {
      return;
    }
    const position = this.getPositionSeconds();
    this.source?.stop();
    this.source = null;
    this.startOffsetSeconds = position;
    this.status = 'paused';
  }

  seek(positionSeconds: number): void {
    const clamped = Math.max(0, Math.min(positionSeconds, this.decoded?.durationSeconds ?? 0));
    const wasPlaying = this.status === 'playing';
    this.source?.stop();
    this.source = null;
    this.startOffsetSeconds = clamped;
    if (wasPlaying) {
      this.startPlaybackFrom(clamped);
    } else if (this.status !== 'idle' && this.status !== 'loading') {
      this.status = 'paused';
    }
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
    this.startOffsetSeconds = 0;
    if (this.status !== 'idle' && this.status !== 'loading') {
      this.status = 'stopped';
    }
  }

  getState(): TrackPlayerState {
    return {
      status: this.status,
      positionSeconds: this.getPositionSeconds(),
      durationSeconds: this.decoded?.durationSeconds ?? 0,
    };
  }

  private getPositionSeconds(): number {
    if (this.status !== 'playing') {
      return this.startOffsetSeconds;
    }
    return this.startOffsetSeconds + (this.engine.now() - this.startedAtEngineTime);
  }

  private startPlaybackFrom(offsetSeconds: number): void {
    if (!this.decoded) {
      return;
    }
    const duration = this.decoded.durationSeconds;
    const source = this.engine.createSource(this.decoded, () => this.handleEnded(source));
    const when = this.engine.now();
    this.engine.scheduleStart(source, when, offsetSeconds);

    this.source = source;
    this.startedAtEngineTime = when;
    this.startOffsetSeconds = offsetSeconds;
    this.status = offsetSeconds >= duration ? 'stopped' : 'playing';
  }

  private handleEnded(source: SourceNode): void {
    // Ignore callbacks from a source we've already moved past (stopped early for pause/seek).
    if (this.source !== source) {
      return;
    }
    this.source = null;
    this.startOffsetSeconds = this.decoded?.durationSeconds ?? 0;
    this.status = 'stopped';
  }
}
