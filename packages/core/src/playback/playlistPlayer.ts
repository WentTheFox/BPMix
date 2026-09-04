import type { AudioEngine, DecodedAudio } from '../audio-engine/types';
import { computeTransitionPlan } from '../crossfade/computeTransitionPlan';
import type { FileRef } from '../file-access/types';
import type { LoopMode } from '../library-store/types';
import { PreloadScheduler } from './preloadScheduler';
import { fisherYatesShuffle } from './shuffle';
import { TrackPlayer, type TrackPlayerState } from './trackPlayer';

/** How many tracks ahead of the current one to keep decoded and ready - the currently playing track plus this many preloaded is "2-3 songs" resident at once. */
const PRELOAD_DEPTH = 2;
/** Default crossfade duration (seconds) if the caller doesn't specify one - matches the plan's 1-10s "Crossfade" setting range, pending the Stage 8 UI control. */
const DEFAULT_CROSSFADE_SECONDS = 5;
/**
 * How far ahead of the fixed fade-start point to start evaluating whether a
 * crossfade can begin (taking the preloaded buffer, calling into the
 * engine) - gives that work a moment to land before the precise moment the
 * transition should audibly start, without meaningfully changing the
 * transition's position within the track (it's re-derived from the plan
 * itself, not from when this check happened to run).
 */
const CROSSFADE_LEAD_SECONDS = 1;
/**
 * Duration (seconds) of the short crossfade a manual next()/previous() does
 * into the target track, in place of an abrupt hard cut - deliberately much
 * shorter than the natural end-of-track crossfade (crossfadeSeconds), which
 * is tuned for blending two tracks' outros/intros together, not for a
 * "just get me to the next song" skip.
 */
const MANUAL_SKIP_CROSSFADE_SECONDS = 1;

export interface PlaylistPlayerState {
  totalTracks: number;
  /** Index into playback order (post-shuffle); -1 if nothing is loaded. */
  position: number;
  currentFileId: string | null;
  loopMode: LoopMode;
  shuffleEnabled: boolean;
  track: TrackPlayerState;
  /**
   * The fileIds actually crossfading right now (matches track.pendingIncoming
   * being non-null; both null otherwise) - explicit rather than inferred
   * from currentFileId/getNextFileId(), since those two mean different
   * things depending on which triggered the crossfade: the natural
   * end-of-track path only advances `position` once the transition
   * completes (currentFileId is still the outgoing track, getNextFileId()
   * the incoming one throughout), while a manual skip (crossfadeToPosition)
   * advances `position` to the target immediately for a snappy UI, so
   * currentFileId is already the incoming track and getNextFileId() means
   * something else entirely (whatever comes after *that*). A caller that
   * needs to label "outgoing"/"incoming" correctly regardless of which
   * triggered the crossfade (e.g. the debug crossfade preview) should use
   * this instead of either of those.
   */
  pendingCrossfadeFileIds: { outgoing: string; incoming: string } | null;
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
  private crossfadeSeconds: number;
  private readonly onDecoded?: (ref: FileRef, decoded: DecodedAudio) => void | Promise<void>;
  private readonly onError?: (error: unknown) => void;
  /**
   * Fired right when playback position changes outside a manual UI action
   * (a crossfade completing, or a track ending naturally and auto-
   * advancing) - callers should refresh their own state immediately rather
   * than relying solely on a periodic poll, which can otherwise leave a
   * "now playing" display showing the outgoing track for as long as it
   * takes the next poll tick to catch up.
   */
  private readonly onAdvance?: () => void;
  private readonly preloadScheduler: PreloadScheduler;
  /**
   * Caches resolveGain()'s result per fileId, warmed in the background by
   * decodeAndNotify() (see its doc) rather than only ever being looked up
   * live at the moment a track actually starts. resolveGain is normally a
   * simple indexed lookup, but on a device backed by react-native-sqlite-2
   * (Android), every query is a full serialized transaction, and a live
   * lookup made right as a manual skip needs it can queue for *seconds*
   * behind whatever concurrent analysis-write transactions the preload
   * scheduler's own decodes are triggering (confirmed on-device: a skip's
   * resolveGain() call took ~7s in exactly this situation - the actual
   * cause of the multi-second freeze at track-switch time, not the decode/
   * buffer-materialization cost prepareBuffer already addresses). Warming
   * this during preload - well before the value is actually needed - moves
   * that same queueing delay off the interactive path entirely, same
   * principle as AudioEngine.prepareBuffer.
   */
  private readonly gainCache = new Map<string, number>();

  private trackFileIds: string[] = [];
  private order: number[] = [];
  private position = -1;
  private loopMode: LoopMode = 'off';
  private shuffleEnabled = false;
  private playToken = 0;
  /** The playback position a crossfade has already been triggered (or ruled out as impossible) for - guards against re-triggering every ~200ms tick for the remainder of the same track. */
  private crossfadeTriggeredForPosition: number | null = null;
  /** True while maybeStartCrossfade's async analysis/gain lookups are in flight - guards against a second tick re-entering and double-triggering before the first attempt has committed or bailed. */
  private crossfadeInFlight = false;
  /**
   * True when the crossfade currently pending on trackPlayer was started by
   * crossfadeToPosition() (a manual next/previous), not maybeStartCrossfade
   * (the natural end-of-track one) - handleCrossfadeCompleted needs to know
   * which, since crossfadeToPosition already advances `position` to the
   * target up front (so preload lookahead/UI reflect the skip immediately,
   * same as playAt() does), whereas the natural path hasn't touched
   * `position` yet and still needs handleCrossfadeCompleted to advance it.
   */
  private crossfadeIsManualSkip = false;
  /** See PlaylistPlayerState.pendingCrossfadeFileIds' doc. Set right before every trackPlayer.crossfadeTo() call (both paths), cleared in handleCrossfadeCompleted. */
  private pendingCrossfadeFileIds: { outgoing: string; incoming: string } | null = null;
  /** See decodeDeduped's doc. */
  private decodingByFileId = new Map<string, Promise<DecodedAudio>>();

  constructor(
    engine: AudioEngine,
    resolveTrack: (fileId: string) => FileRef | Promise<FileRef>,
    options: {
      onError?: (error: unknown) => void;
      /** Normalization gain (Stage 5) for a track, e.g. from its stored AnalysisResult - defaults to 1 (no change) if omitted or it throws. */
      resolveGain?: (fileId: string) => number | Promise<number>;
      /** Crossfade duration (seconds) - same value used for computeTransitionPlan, so what's scheduled matches what any preview UI shows. Defaults to DEFAULT_CROSSFADE_SECONDS. */
      crossfadeSeconds?: number;
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
      /** See the onAdvance field doc. */
      onAdvance?: () => void;
    } = {},
  ) {
    this.engine = engine;
    this.resolveTrack = resolveTrack;
    this.crossfadeSeconds = options.crossfadeSeconds ?? DEFAULT_CROSSFADE_SECONDS;
    this.onError = options.onError;
    this.resolveGain = options.resolveGain;
    this.onDecoded = options.onDecoded;
    this.onAdvance = options.onAdvance;
    this.trackPlayer = new TrackPlayer(engine, {
      onEnded: () => this.handleTrackEnded(),
      onCrossfadeCompleted: () => this.handleCrossfadeCompleted(),
    });
    this.preloadScheduler = new PreloadScheduler({
      decode: (fileId) => this.decodeDeduped(fileId),
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
    // See AudioEngine.prepareBuffer's doc - does createSource()'s otherwise-
    // lazy native-buffer setup now. For the preload scheduler (this decode
    // finishing well ahead of when the track is actually needed), that
    // moves a real synchronous stall off the track-switch/crossfade moment;
    // for a cache-miss cold decode it's no worse (createSource would do the
    // identical work moments later regardless).
    this.engine.prepareBuffer?.(decoded);
    // Warms this.gainCache in the background too - see its doc for why this
    // (not just the audio buffer) needs to happen ahead of time as well.
    // Fire-and-forget: nothing here needs to block returning `decoded`.
    void this.resolveGainFor(fileId);
    try {
      // Fire-and-forget (never awaited here - decoded is returned to the
      // caller, e.g. for playback, immediately below regardless), but an
      // engine whose decodeFile() can resolve before channelData holds
      // real data (Windows - see AudioEngine.awaitAnalysisReady) needs
      // this to wait for that before onDecoded reads it for analysis.
      void Promise.resolve(this.engine.awaitAnalysisReady?.(decoded))
        .then(() => this.onDecoded?.(ref, decoded))
        .catch(() => {});
    } catch {
      // onDecoded threw synchronously - it's fire-and-forget, never let it affect playback.
    }
    return decoded;
  }

  /**
   * Same as decodeAndNotify, but de-duplicated across every caller
   * (the preload scheduler, playAt()'s cache-miss fallback, and
   * crossfadeToPosition()'s) - without this, the preload scheduler could
   * already be mid-decode for a fileId (e.g. it's next up in the lookahead
   * window) at the exact moment a manual skip or natural advance reaches
   * that same fileId before the preload finishes; takePreloaded() finds
   * nothing ready yet, and a second decodeFile() call for the identical
   * file starts concurrently with the first. On Windows this native
   * decode opens the file itself (not a shared handle), so two overlapping
   * decodes of the same file threw a real on-device "the file is in use"
   * error (regression: only became reachable once manual skips started
   * decoding at all, via crossfadeToPosition - shuffle just made the
   * timing more likely to land in that window). Every caller now shares
   * whatever decode for that fileId is already in flight instead.
   */
  private decodeDeduped(fileId: string): Promise<DecodedAudio> {
    const existing = this.decodingByFileId.get(fileId);
    if (existing) return existing;
    const promise = this.decodeAndNotify(fileId).finally(() => {
      if (this.decodingByFileId.get(fileId) === promise) {
        this.decodingByFileId.delete(fileId);
      }
    });
    this.decodingByFileId.set(fileId, promise);
    return promise;
  }

  /** Loads a new playlist and starts playing at the given track (default: the first). */
  async setPlaylist(trackFileIds: string[], startFileId?: string): Promise<void> {
    await this.loadPlaylistAt(trackFileIds, startFileId, { autoplay: true });
  }

  /**
   * Same as setPlaylist, but leaves the track loaded-and-paused instead of
   * starting playback - for restoring a saved position on launch, where
   * autoplaying audio before the UI has rendered any controls would be a
   * surprise. Unlike setPlaylist, which browsers' autoplay policy silently
   * no-ops on web until a real user gesture, native platforms have no such
   * protection - audio would genuinely start playing.
   */
  async loadPlaylist(trackFileIds: string[], startFileId?: string): Promise<void> {
    await this.loadPlaylistAt(trackFileIds, startFileId, { autoplay: false });
  }

  private async loadPlaylistAt(trackFileIds: string[], startFileId: string | undefined, options: { autoplay: boolean }): Promise<void> {
    this.trackFileIds = trackFileIds;
    this.order = this.shuffleEnabled ? fisherYatesShuffle(trackFileIds.map((_, i) => i)) : trackFileIds.map((_, i) => i);
    const startPosition = startFileId
      ? this.order.findIndex((trackIndex) => this.trackFileIds[trackIndex] === startFileId)
      : 0;
    await this.playAt(startPosition === -1 ? 0 : startPosition, options);
  }

  setLoopMode(mode: LoopMode): void {
    this.loopMode = mode;
  }

  /** Changes the crossfade duration used for any future transition - takes effect the next time maybeStartCrossfade evaluates, not retroactively on one already in flight. */
  setCrossfadeSeconds(seconds: number): void {
    this.crossfadeSeconds = seconds;
  }

  getCrossfadeSeconds(): number {
    return this.crossfadeSeconds;
  }

  /** Sets the user-facing master volume [0,1] (e.g. a UI slider) - independent of per-track normalization gain (resolveGain), applies immediately. */
  setVolume(value: number): void {
    this.trackPlayer.setVolume(value);
  }

  getVolume(): number {
    return this.trackPlayer.getVolume();
  }

  /** See TrackPlayer.getFrequencyBands' doc. */
  getFrequencyBands(bandCount: number): { outgoing: number[]; incoming: number[] } {
    return this.trackPlayer.getFrequencyBands(bandCount);
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
        await this.crossfadeToPosition(0);
      }
      return;
    }
    await this.crossfadeToPosition(this.position + 1);
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
        await this.crossfadeToPosition(this.order.length - 1);
      }
      return;
    }
    await this.crossfadeToPosition(this.position - 1);
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
    void this.maybeStartCrossfade(trackState);
  }

  /**
   * Once the current track is within crossfadeSeconds (plus a small
   * lead-in) of ending, and the next track's buffer is already preloaded,
   * computes a fixed-lead-time volume-only TransitionPlan (see
   * computeTransitionPlan's doc - no BPM/analysis lookup needed at all
   * this round) and hands it to TrackPlayer.crossfadeTo() so the transition
   * is actually scheduled on the engine - not just previewed. If the
   * preload isn't ready in time, this simply does nothing and the track
   * proceeds to its existing hard-cut natural end.
   */
  private async maybeStartCrossfade(trackState: TrackPlayerState): Promise<void> {
    if (this.crossfadeInFlight) return;
    if (trackState.status !== 'playing') return;
    if (this.crossfadeTriggeredForPosition === this.position) return;
    // A manual skip's own short crossfade is already in flight - defer to
    // it rather than potentially racing a second crossfadeTo on top of it
    // (TrackPlayer would cancel the manual one for this new one, but by
    // then `this.position` already points past the manual skip's target,
    // so getNextFileId() below would resolve to the wrong track entirely).
    if (trackState.pendingIncoming && this.crossfadeIsManualSkip) return;
    const remaining = trackState.durationSeconds - trackState.positionSeconds;
    if (remaining > this.crossfadeSeconds + CROSSFADE_LEAD_SECONDS) return;

    const nextFileId = this.getNextFileId();
    if (!nextFileId || !this.preloadScheduler.hasPreloaded(nextFileId)) return;

    const position = this.position;
    const token = this.playToken;
    this.crossfadeInFlight = true;
    try {
      const incomingGain = await this.resolveGainFor(nextFileId);
      // A manual skip/track change landed while the lookup above was in
      // flight - the transition this was computing for no longer applies.
      if (token !== this.playToken || position !== this.position) return;

      const decoded = this.preloadScheduler.takePreloaded(nextFileId);
      if (!decoded) return; // taken or expired since the check above - rare; falls back to the natural hard-cut end

      const currentTrackIndex = this.order[this.position];
      const currentFileId = currentTrackIndex !== undefined ? this.trackFileIds[currentTrackIndex] : undefined;

      const plan = computeTransitionPlan(trackState.durationSeconds, this.crossfadeSeconds);
      if (currentFileId !== undefined) {
        this.pendingCrossfadeFileIds = { outgoing: currentFileId, incoming: nextFileId };
      }
      this.trackPlayer.crossfadeTo(decoded, plan, incomingGain);
      // Mark this position as handled whether crossfadeTo actually started
      // a transition or declined (e.g. status changed underneath us) -
      // either way, retrying on the very next ~200ms tick would just
      // re-evaluate the same already-decided outcome. This also covers a
      // crossfadeTo that partially scheduled something before throwing
      // (falls to the catch below) - without this, a genuinely repeatable
      // failure would retry every tick, each attempt scheduling another
      // conflicting gain automation on top of whatever the previous
      // attempt already got applied to the outgoing source.
      this.crossfadeTriggeredForPosition = position;
    } catch (error) {
      this.crossfadeTriggeredForPosition = position;
      this.onError?.(error);
    } finally {
      this.crossfadeInFlight = false;
    }
  }

  /**
   * The transition scheduled by maybeStartCrossfade has completed and
   * TrackPlayer has already swapped over to the incoming track's audio -
   * this just catches PlaylistPlayer's own position bookkeeping up to
   * match (mirroring the same advance handleTrackEnded would have made),
   * so getState()/preload lookahead reflect what's actually playing now.
   * No playAt() call here - the audio is already playing. Fires onAdvance
   * immediately rather than leaving callers to notice on their next poll.
   */
  private handleCrossfadeCompleted(): void {
    // See crossfadeIsManualSkip's doc - a manual skip already advanced
    // `position` to its target up front; only the natural end-of-track
    // path still needs it advanced here.
    if (!this.crossfadeIsManualSkip) {
      const isLast = this.position >= this.order.length - 1;
      this.position = isLast ? 0 : this.position + 1;
    }
    this.crossfadeIsManualSkip = false;
    this.pendingCrossfadeFileIds = null;
    this.crossfadeTriggeredForPosition = null;
    this.onAdvance?.();
  }

  /** The track that would play next (respecting loop mode/shuffle order), or null if there isn't one - e.g. for a Stage 7 crossfade preview. */
  getNextFileId(): string | null {
    return this.computeUpcomingFileIds(1)[0] ?? null;
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
      pendingCrossfadeFileIds: this.pendingCrossfadeFileIds,
    };
  }

  /**
   * Manual next()/previous() target - crossfades into the target track over
   * MANUAL_SKIP_CROSSFADE_SECONDS instead of playAt()'s abrupt hard cut, as
   * long as something's actually playing to crossfade away from (otherwise
   * there's nothing to blend and a hard cut is already correct - e.g. the
   * very first track, or skipping while paused/stopped).
   */
  private async crossfadeToPosition(position: number): Promise<void> {
    const trackIndex = this.order[position];
    if (trackIndex === undefined) return;
    const fileId = this.trackFileIds[trackIndex];
    if (fileId === undefined) return;

    const trackState = this.trackPlayer.getState();
    if (trackState.status !== 'playing') {
      await this.playAt(position);
      return;
    }

    // Captured before `position` is reassigned below - see
    // PlaylistPlayerState.pendingCrossfadeFileIds' doc for why this can't
    // just be re-derived from currentFileId afterward.
    const outgoingTrackIndex = this.order[this.position];
    const outgoingFileId = outgoingTrackIndex !== undefined ? this.trackFileIds[outgoingTrackIndex] : undefined;

    this.position = position;
    const token = ++this.playToken;
    try {
      const preloaded = this.preloadScheduler.takePreloaded(fileId);
      const [decoded, gain] = await Promise.all([
        preloaded ? Promise.resolve(preloaded) : this.decodeDeduped(fileId),
        this.resolveGainFor(fileId),
      ]);
      if (token !== this.playToken) return;

      const plan = {
        fadeStartSeconds: trackState.positionSeconds,
        fadeDurationSeconds: MANUAL_SKIP_CROSSFADE_SECONDS,
        incomingStartSeconds: 0,
      };
      this.crossfadeIsManualSkip = true;
      if (outgoingFileId !== undefined) {
        this.pendingCrossfadeFileIds = { outgoing: outgoingFileId, incoming: fileId };
      }
      const started = this.trackPlayer.crossfadeTo(decoded, plan, gain);
      if (!started) {
        // The outgoing track stopped being "playing" while we were
        // decoding (e.g. a pause landed in the meantime) - nothing left to
        // crossfade away from, fall back to the same hard cut playAt()
        // would have done.
        this.crossfadeIsManualSkip = false;
        this.pendingCrossfadeFileIds = null;
        this.trackPlayer.setGain(gain);
        this.trackPlayer.loadDecoded(decoded);
        this.trackPlayer.play();
      }
    } catch (error) {
      if (token === this.playToken) {
        this.onError?.(error);
      }
    }
  }

  private async playAt(position: number, options: { autoplay: boolean } = { autoplay: true }): Promise<void> {
    const trackIndex = this.order[position];
    if (trackIndex === undefined) return;
    const fileId = this.trackFileIds[trackIndex];
    if (fileId === undefined) return;
    this.position = position;
    this.trackPlayer.markLoading();
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
        preloaded ? Promise.resolve(preloaded) : this.decodeDeduped(fileId),
        this.resolveGainFor(fileId),
      ]);
      if (token !== this.playToken) return;
      this.trackPlayer.setGain(gain);
      this.trackPlayer.loadDecoded(decoded);
      if (options.autoplay) this.trackPlayer.play();
    } catch (error) {
      if (token === this.playToken) {
        this.onError?.(error);
      }
    }
  }

  /** Falls back to 1 (no change) if no resolveGain was given, or it fails - a missing/failed gain lookup shouldn't block playback. Cached per fileId (see gainCache's doc) - a resolveGain call that already ran once (typically warmed by decodeAndNotify well ahead of time) never re-queries. */
  private async resolveGainFor(fileId: string): Promise<number> {
    const cached = this.gainCache.get(fileId);
    if (cached !== undefined) return cached;
    if (!this.resolveGain) return 1;
    try {
      const gain = await this.resolveGain(fileId);
      this.gainCache.set(fileId, gain);
      return gain;
    } catch {
      return 1;
    }
  }

  /** Auto-advance on natural end (as opposed to a manual next()/previous()/setPlaylist() call) - fires onAdvance once the new track is actually loaded, same as handleCrossfadeCompleted, for the same immediate-refresh reason (see onAdvance's doc). */
  private handleTrackEnded(): void {
    if (this.loopMode === 'one') {
      void this.playAt(this.position).then(() => this.onAdvance?.());
      return;
    }
    const isLast = this.position >= this.order.length - 1;
    if (isLast) {
      if (this.loopMode === 'all') {
        void this.playAt(0).then(() => this.onAdvance?.());
      }
      return;
    }
    void this.playAt(this.position + 1).then(() => this.onAdvance?.());
  }
}
