import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';

export type TrackPlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

export interface TrackPlayerState {
  status: TrackPlayerStatus;
  positionSeconds: number;
  durationSeconds: number;
}

export interface TrackPlayerCallbacks {
  /** Fired when the track finishes playing on its own - never on an explicit stop()/pause()/seek(). */
  onEnded?: () => void;
}

/**
 * Play/pause/seek/stop on top of the engine's one-shot SourceNode primitive.
 * A SourceNode can't be paused or restarted once stopped, so this stops the
 * current source and creates a new one (at the resume/seek offset) whenever
 * playback needs to continue from somewhere other than "where it just was".
 */
export class TrackPlayer {
  private readonly engine: AudioEngine;
  private readonly callbacks: TrackPlayerCallbacks;
  private decoded: DecodedAudio | null = null;
  private source: SourceNode | null = null;
  private status: TrackPlayerStatus = 'idle';
  private startedAtEngineTime = 0;
  private startOffsetSeconds = 0;
  private loadToken = 0;

  constructor(engine: AudioEngine, callbacks: TrackPlayerCallbacks = {}) {
    this.engine = engine;
    this.callbacks = callbacks;
  }

  async load(ref: FileRef): Promise<void> {
    this.stop();
    this.status = 'loading';
    // If a newer load() supersedes this one before decodeFile() resolves,
    // this call must not touch state on completion - PlaylistPlayer's own
    // playToken guard stops a stale load from being *played*, but without
    // this, a slow superseded decode finishing after a newer, faster one
    // has already started playing would silently overwrite this.decoded
    // and force status back to 'stopped' out from under the track that's
    // actually audible right now.
    const token = ++this.loadToken;
    const decoded = await this.engine.decodeFile(ref);
    if (token !== this.loadToken) {
      return;
    }
    this.decoded = decoded;
    this.startOffsetSeconds = 0;
    this.status = 'stopped';
  }

  play(): void {
    // A no-op, not a throw: a manual play() landing while a load() is still
    // in flight (e.g. the user tapping Play while a track switch is still
    // decoding) has nothing to do yet - callers that want auto-play once
    // ready (PlaylistPlayer.playAt does) call play() again after load()
    // resolves. An uncaught throw from a UI click handler is worse than
    // silently ignoring this harmless race.
    if (!this.decoded || this.status === 'loading') {
      return;
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
    this.stopCurrentSource();
    this.startOffsetSeconds = position;
    this.status = 'paused';
  }

  seek(positionSeconds: number): void {
    if (!Number.isFinite(positionSeconds)) {
      // Guards against bad input anywhere upstream (e.g. a UI coordinate
      // calculation gone wrong) turning into a non-finite value the engine
      // has to reject - see startPlaybackFrom's scheduleStart catch for what
      // happens if one gets through anyway.
      return;
    }
    const clamped = Math.max(0, Math.min(positionSeconds, this.decoded?.durationSeconds ?? 0));
    const wasPlaying = this.status === 'playing';
    this.stopCurrentSource();
    this.startOffsetSeconds = clamped;
    if (wasPlaying) {
      this.startPlaybackFrom(clamped);
    } else if (this.status !== 'idle' && this.status !== 'loading') {
      this.status = 'paused';
    }
  }

  stop(): void {
    this.stopCurrentSource();
    this.startOffsetSeconds = 0;
    if (this.status !== 'idle' && this.status !== 'loading') {
      this.status = 'stopped';
    }
  }

  /**
   * Nulls this.source BEFORE calling stop() on the old one, not after. Some
   * native engines invoke the source's onEnded callback synchronously from
   * within stop() (unlike the browser, where it's always async) - if
   * this.source still pointed at the source being stopped when that fires,
   * handleEnded's "is this a stale/superseded source" guard would see them
   * as equal and treat an intentional stop as a natural end, potentially
   * cascading into overlapping playAt() calls under rapid seeking.
   */
  private stopCurrentSource(): void {
    const oldSource = this.source;
    this.source = null;
    oldSource?.stop();
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
    if (offsetSeconds >= duration) {
      // Nothing left to play - don't hand the engine a zero-length source.
      // Some native engines resolve/fire onEnded for that synchronously
      // (see stopCurrentSource's note), which doesn't do anything harmful
      // here since we're already about to land on this exact state, but
      // there's no reason to round-trip through the engine for it either.
      this.source = null;
      this.startOffsetSeconds = duration;
      this.status = 'stopped';
      return;
    }

    const when = this.engine.now();
    const source = this.engine.createSource(this.decoded, () => this.handleEnded(source));
    // Assigned before scheduleStart (not after): if the engine invokes onEnded
    // synchronously from within it - some native engines do, for a source
    // that turns out to have nothing playable - handleEnded's staleness guard
    // needs this.source to already equal the new source, so it processes a
    // genuine immediate end correctly instead of silently dropping it.
    this.source = source;
    this.startedAtEngineTime = when;
    this.startOffsetSeconds = offsetSeconds;
    this.status = 'playing';
    try {
      this.engine.scheduleStart(source, when, offsetSeconds);
    } catch {
      // The engine rejected this start (e.g. native throws synchronously on
      // a non-finite offset). Without this, state above already claims
      // status='playing' with this.source pointing at a source that was
      // never actually started - nothing will ever fire its onEnded, so the
      // player would be stuck forever (this is what "playback just stops
      // and never advances" traced back to). Treat it as an immediate
      // natural end instead, so a playlist can move on to the next track.
      this.handleEnded(source);
    }
  }

  private handleEnded(source: SourceNode): void {
    // Ignore callbacks from a source we've already moved past (stopped early for pause/seek).
    if (this.source !== source) {
      return;
    }
    this.source = null;
    this.startOffsetSeconds = this.decoded?.durationSeconds ?? 0;
    this.status = 'stopped';
    this.callbacks.onEnded?.();
  }
}
