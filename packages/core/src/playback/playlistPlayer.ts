import type { AudioEngine, DecodedAudio } from '../audio-engine/types';
import type { FileRef } from '../file-access/types';
import type { LoopMode } from '../library-store/types';
import { PreloadScheduler } from './preloadScheduler';
import { fisherYatesShuffle } from './shuffle';
import { TrackPlayer, type TrackPlayerState } from './trackPlayer';

/** How many tracks ahead of the current one to keep decoded and ready - the currently playing track plus this many preloaded is "2-3 songs" resident at once. */
const PRELOAD_DEPTH = 2;

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
  private readonly engine: AudioEngine;
  private readonly trackPlayer: TrackPlayer;
  private readonly resolveTrack: (fileId: string) => FileRef | Promise<FileRef>;
  private readonly resolveGain?: (fileId: string) => number | Promise<number>;
  private readonly onDecoded?: (ref: FileRef, decoded: DecodedAudio) => void | Promise<void>;
  private readonly onError?: (error: unknown) => void;
  private readonly preloadScheduler: PreloadScheduler;

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
      /**
       * Fired (fire-and-forget - never awaited, never blocks playback)
       * whenever a track is freshly decoded, whether for immediate playback
       * or preload lookahead. Lets a caller lazily analyze+cache a track
       * (Stage 4) the first time it's actually needed instead of an eager
       * batch pass over the whole library - that pass turned out to starve
       * the UI thread for as long as it ran, for tracks that might never
       * even get played.
       */
      onDecoded?: (ref: FileRef, decoded: DecodedAudio) => void | Promise<void>;
    } = {},
  ) {
    this.engine = engine;
    this.resolveTrack = resolveTrack;
    this.onError = options.onError;
    this.resolveGain = options.resolveGain;
    this.onDecoded = options.onDecoded;
    this.trackPlayer = new TrackPlayer(engine, { onEnded: () => this.handleTrackEnded() });
    this.preloadScheduler = new PreloadScheduler({
      decode: (fileId) => this.decodeAndNotify(fileId),
      // Stage 6's "flag a playback error" - playback itself is unaffected,
      // playAt() just decodes cold (its existing fallback) when it gets
      // there, since an empty preload cache is a no-op, not a special case.
      onGiveUp: (fileId) =>
        this.onError?.(new Error(`Preload failed for track ${fileId} after every retry - it'll load normally when reached.`)),
    });
  }

  /** Decodes a track and fires onDecoded - the single decode path shared by playAt()'s cache-miss case and the preload scheduler, so both feed the same just-in-time analysis hook. */
  private async decodeAndNotify(fileId: string): Promise<DecodedAudio> {
    const ref = await this.resolveTrack(fileId);
    const decoded = await this.engine.decodeFile(ref);
    try {
      void Promise.resolve(this.onDecoded?.(ref, decoded)).catch(() => {});
    } catch {
      // onDecoded threw synchronously - it's fire-and-forget, never let it affect playback.
    }
    return decoded;
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

  /**
   * Drives the Stage 6 lookahead preload scheduler - call this regularly
   * (both apps do it from their existing ~200ms UI poll interval, rather
   * than adding a second timer) while a track is playing or paused.
   */
  checkPreload(): void {
    if (this.order.length === 0) return;
    const trackState = this.trackPlayer.getState();
    if (trackState.status !== 'playing' && trackState.status !== 'paused') return;
    this.preloadScheduler.tick({
      remainingSeconds: trackState.durationSeconds - trackState.positionSeconds,
      upcomingFileIds: this.computeUpcomingFileIds(PRELOAD_DEPTH),
    });
  }

  /** The next `depth` tracks' fileIds after the current position, nearest first, respecting loop mode. */
  private computeUpcomingFileIds(depth: number): string[] {
    if (this.loopMode === 'one' || this.order.length <= 1) return [];
    const result: string[] = [];
    for (let i = 1; i <= depth; i++) {
      let pos = this.position + i;
      if (pos >= this.order.length) {
        if (this.loopMode !== 'all') break; // loop off - nothing past the end
        pos = pos % this.order.length;
      }
      const trackIndex = this.order[pos];
      if (trackIndex === undefined) break;
      const fileId = this.trackFileIds[trackIndex];
      if (fileId === undefined) break;
      result.push(fileId);
    }
    return result;
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
      // A track the preload scheduler already finished decoding skips
      // straight to loadDecoded() - no redundant decodeFile() round trip,
      // and effectively instant since there's nothing left to await there.
      const preloaded = this.preloadScheduler.takePreloaded(fileId);
      const [decoded, gain] = await Promise.all([
        preloaded ? Promise.resolve(preloaded) : this.decodeAndNotify(fileId),
        this.resolveGainFor(fileId),
      ]);
      if (token !== this.playToken) return;
      this.trackPlayer.setGain(gain);
      this.trackPlayer.loadDecoded(decoded);
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
