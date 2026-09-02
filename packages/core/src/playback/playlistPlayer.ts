import type { AudioEngine } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { LoopMode } from '../library-store/types';
import { fisherYatesShuffle } from './shuffle';
import { TrackPlayer, type TrackPlayerState } from './trackPlayer';

export interface PlaylistPlayerState {
  totalTracks: number;
  /** Index into playback order (post-shuffle); -1 if nothing is loaded. */
  position: number;
  currentFileId: string | null;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
  track: TrackPlayerState;
}

/**
 * Sequences a playlist's tracks through a single TrackPlayer: play order
 * (sequential or shuffled), loop mode, and next/prev. Still a hard cut
 * between tracks - the crossfade engine builds on top of this later.
 *
 * Manual next()/previous() respect loop mode: loop='all' wraps at the
 * playlist boundary, loop='one' restarts the current track instead of
 * changing tracks (there's no natural "previous/next" while repeating one
 * song), and loop='off' just clamps at the boundary. Pass { force: true }
 * to always move to the literal next/previous track regardless of loop mode
 * (wrapping at the boundary too) - the UI's double-tap gesture uses this to
 * let you escape loop='one'/'off' clamping when you explicitly want to.
 */
export class PlaylistPlayer {
  private readonly trackPlayer: TrackPlayer;
  private readonly resolveTrack: (fileId: string) => FileRef | Promise<FileRef>;
  private readonly resolveGain?: (fileId: string) => number | Promise<number>;
  private readonly onError?: (error: unknown) => void;

  private trackFileIds: string[] = [];
  private order: number[] = [];
  private position = -1;
  private loopMode: LoopMode = 'off';
  private shuffleEnabled = false;
  private playToken = 0;

  constructor(
    engine: AudioEngine,
    resolveTrack: (fileId: string) => FileRef | Promise<FileRef>,
    options: {
      onError?: (error: unknown) => void;
      /** Normalization gain (Stage 5) for a track, e.g. from its stored AnalysisResult - defaults to 1 (no change) if omitted or it throws. */
      resolveGain?: (fileId: string) => number | Promise<number>;
    } = {},
  ) {
    this.resolveTrack = resolveTrack;
    this.onError = options.onError;
    this.resolveGain = options.resolveGain;
    this.trackPlayer = new TrackPlayer(engine, { onEnded: () => this.handleTrackEnded() });
  }

  /** Loads a new playlist and starts playing at the given track (default: the first). */
  async setPlaylist(trackFileIds: string[], startFileId?: string): Promise<void> {
    this.trackFileIds = trackFileIds;
    this.order = this.shuffleEnabled ? fisherYatesShuffle(trackFileIds.map((_, i) => i)) : trackFileIds.map((_, i) => i);
    const startPosition = startFileId
      ? this.order.findIndex((trackIndex) => this.trackFileIds[trackIndex] === startFileId)
      : 0;
    await this.playAt(startPosition === -1 ? 0 : startPosition);
  }

  setLoopMode(mode: LoopMode): void {
    this.loopMode = mode;
  }

  /** Re-shuffles (or restores original order) without interrupting the currently playing track. */
  setShuffle(enabled: boolean): void {
    if (this.shuffleEnabled === enabled || this.trackFileIds.length === 0) {
      this.shuffleEnabled = enabled;
      return;
    }
    const currentTrackIndex = this.position >= 0 ? this.order[this.position] : undefined;
    this.shuffleEnabled = enabled;
    this.order = enabled
      ? fisherYatesShuffle(this.trackFileIds.map((_, i) => i))
      : this.trackFileIds.map((_, i) => i);
    if (currentTrackIndex !== undefined) {
      const newPosition = this.order.indexOf(currentTrackIndex);
      this.position = newPosition === -1 ? 0 : newPosition;
    }
  }

  play(): void {
    this.trackPlayer.play();
  }

  pause(): void {
    this.trackPlayer.pause();
  }

  seek(positionSeconds: number): void {
    this.trackPlayer.seek(positionSeconds);
  }

  async next(options: { force?: boolean } = {}): Promise<void> {
    if (this.order.length === 0) return;
    if (!options.force && this.loopMode === 'one') {
      this.trackPlayer.seek(0);
      return;
    }
    const isLast = this.position >= this.order.length - 1;
    if (isLast) {
      if (options.force || this.loopMode === 'all') {
        await this.playAt(0);
      }
      return;
    }
    await this.playAt(this.position + 1);
  }

  async previous(options: { force?: boolean } = {}): Promise<void> {
    if (this.order.length === 0) return;
    if (!options.force && this.loopMode === 'one') {
      this.trackPlayer.seek(0);
      return;
    }
    const isFirst = this.position <= 0;
    if (isFirst) {
      if (options.force || this.loopMode === 'all') {
        await this.playAt(this.order.length - 1);
      }
      return;
    }
    await this.playAt(this.position - 1);
  }

  getState(): PlaylistPlayerState {
    const currentTrackIndex = this.position >= 0 ? this.order[this.position] : undefined;
    return {
      totalTracks: this.trackFileIds.length,
      position: this.position,
      currentFileId: currentTrackIndex !== undefined ? (this.trackFileIds[currentTrackIndex] ?? null) : null,
      loopMode: this.loopMode,
      shuffleEnabled: this.shuffleEnabled,
      track: this.trackPlayer.getState(),
    };
  }

  private async playAt(position: number): Promise<void> {
    const trackIndex = this.order[position];
    if (trackIndex === undefined) return;
    const fileId = this.trackFileIds[trackIndex];
    if (fileId === undefined) return;
    this.position = position;
    // If a newer playAt() (from a rapid manual skip, or a duplicate/spurious
    // onEnded firing) starts before this one finishes decoding, this call's
    // eventual .play() must not run - two overlapping loads racing to start
    // playback was the second half of what caused the native crash this
    // guards against (the first half was TrackPlayer's own stop-vs-onEnded
    // ordering bug).
    const token = ++this.playToken;
    try {
      const [ref, gain] = await Promise.all([this.resolveTrack(fileId), this.resolveGainFor(fileId)]);
      if (token !== this.playToken) return;
      this.trackPlayer.setGain(gain);
      await this.trackPlayer.load(ref);
      if (token !== this.playToken) return;
      this.trackPlayer.play();
    } catch (error) {
      if (token === this.playToken) {
        this.onError?.(error);
      }
    }
  }

  /** Falls back to 1 (no change) if no resolveGain was given, or it fails - a missing/failed gain lookup shouldn't block playback. */
  private async resolveGainFor(fileId: string): Promise<number> {
    if (!this.resolveGain) return 1;
    try {
      return await this.resolveGain(fileId);
    } catch {
      return 1;
    }
  }

  private handleTrackEnded(): void {
    if (this.loopMode === 'one') {
      void this.playAt(this.position);
      return;
    }
    const isLast = this.position >= this.order.length - 1;
    if (isLast) {
      if (this.loopMode === 'all') {
        void this.playAt(0);
      }
      return;
    }
    void this.playAt(this.position + 1);
  }
}
