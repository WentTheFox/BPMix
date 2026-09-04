import type { AudioEngine, DecodedAudio, SourceNode } from '../audio-engine/types';
import type { TransitionPlan } from '../crossfade/computeTransitionPlan';
import { sampleEqualPowerGainCurve } from '../crossfade/equalPowerGain';
import type { FileRef } from '../file-access/types';

/** How many points to sample the equal-power gain curve at for crossfadeTo's rampGainCurve calls - the engine interpolates between them, so this just needs to be smooth enough to not sound stepped. */
const GAIN_CURVE_SAMPLE_COUNT = 32;
/**
 * Extra real seconds the outgoing source is left playing (already silent,
 * per the gain curve) after its fade curve's own nominal duration, before
 * its stop() is actually scheduled - a cushion against the physical cutoff
 * landing a hair before the ramp automation has genuinely finished (native
 * scheduling/thread timing isn't perfectly exact), which would otherwise be
 * audible as an abrupt cutoff rather than the fade actually reaching
 * silence on its own.
 */
const STOP_TAIL_SECONDS = 0.2;
/** Cap for the fade-out on pause() and fade-in on play()/resume - avoids an audible pop/click from an instant gain cut or jump, while staying quick enough that it doesn't read as a real crossfade. */
const PAUSE_RESUME_FADE_SECONDS = 0.5;

export type TrackPlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped';

export interface TrackPlayerState {
  status: TrackPlayerStatus;
  positionSeconds: number;
  durationSeconds: number;
  /**
   * The incoming side of a crossfade already scheduled by crossfadeTo(),
   * live-tracked the same way positionSeconds/durationSeconds are for the
   * outgoing track - null when there's no crossfade in flight. A caller
   * that switches its own display (track name, seek bar) to this the
   * instant it's non-null, rather than waiting for onCrossfadeCompleted,
   * avoids an abrupt seek-bar jump: without it, the bar keeps climbing
   * toward the OUTGOING track's own duration for the entire audible fade,
   * then snaps to a small fraction of the (usually much longer) incoming
   * track's duration the instant the swap actually completes - jarring,
   * and out of sync with what's actually audible throughout the fade.
   */
  pendingIncoming: { positionSeconds: number; durationSeconds: number; fadeDurationSeconds: number } | null;
}

export interface TrackPlayerCallbacks {
  /** Fired when the track finishes playing on its own - never on an explicit stop()/pause()/seek(), and never for a track that ended via crossfadeTo() (see onCrossfadeCompleted). */
  onEnded?: () => void;
  /**
   * Fired when a transition scheduled by crossfadeTo() actually completes
   * and the incoming track becomes "current" - distinct from onEnded,
   * since the transition already started the next track's audio itself;
   * callers should just advance their own position bookkeeping (as
   * PlaylistPlayer does), not call playAt()/load() again.
   */
  onCrossfadeCompleted?: () => void;
}

interface PendingCrossfade {
  source: SourceNode;
  decoded: DecodedAudio;
  startedAtEngineTime: number;
  startOffsetSeconds: number;
  gain: number;
  rate: number;
  fadeDurationSeconds: number;
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
  private currentGain = 1;
  /**
   * The rate the current source is actually playing at - always 1 for now
   * (no rate/speed manipulation this round - see computeTransitionPlan's
   * doc). Kept, rather than assumed to always be 1, so position tracking
   * (getPositionSeconds) stays correct if a rate change comes back in a
   * later round; re-applied to every new source the same way currentGain is
   * (seek/pause/resume all tear down and recreate the source).
   */
  private currentRate = 1;
  /** User-facing master volume [0,1], independent of currentGain (per-track normalization) - the two multiply together into whatever's actually sent to the engine. Persists across tracks (unlike currentGain, which is per-track), same reasoning as currentRate/currentGain: sources are torn down and recreated on every seek/pause/resume, so this has to be remembered and re-applied each time. */
  private masterVolume = 1;
  private pendingCrossfade: PendingCrossfade | null = null;

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
    this.applyDecoded(decoded);
  }

  /**
   * Marks status='loading' immediately, synchronously - for callers (like
   * PlaylistPlayer.playAt) that decode outside of load() (e.g. to run the
   * decode and gain lookup concurrently) but still want getState() to
   * reflect "loading" for the whole decode window rather than leaving
   * status parked on whatever it was left at until loadDecoded() resolves.
   */
  markLoading(): void {
    this.status = 'loading';
  }

  /**
   * Loads an already-decoded buffer synchronously - no decodeFile() round
   * trip. Used by PlaylistPlayer's preload scheduler (Stage 6) to make an
   * advance to a track it already finished decoding ahead of time
   * effectively instant, instead of redundantly decoding it again.
   */
  loadDecoded(decoded: DecodedAudio): void {
    this.stop();
    ++this.loadToken; // invalidates any in-flight async load() a caller might have started and then superseded with this
    this.applyDecoded(decoded);
  }

  private applyDecoded(decoded: DecodedAudio): void {
    this.decoded = decoded;
    this.startOffsetSeconds = 0;
    this.status = 'stopped';
    // A fresh load always starts at normal speed - only an in-progress
    // crossfade (see currentRate's doc) can set this to anything else, and
    // that shouldn't leak into an unrelated track loaded afterward.
    this.currentRate = 1;
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
    // Only a genuine resume-from-pause fades in - a fresh track start
    // (status 'stopped'/'idle', e.g. tapping a track in the list, or
    // PlaylistPlayer.playAt loading the next one) should still begin at
    // full volume immediately rather than easing in.
    const isResume = this.status === 'paused';
    this.startPlaybackFrom(this.startOffsetSeconds, isResume ? PAUSE_RESUME_FADE_SECONDS : 0);
  }

  pause(): void {
    if (this.status !== 'playing') {
      return;
    }
    const position = this.getPositionSeconds();
    // Cancel any in-flight crossfade first (same as stopCurrentSource), then
    // fade this.source out and schedule its stop rather than cutting it
    // immediately - an instant gain cut on pause is an audible pop/click.
    // this.source is nulled before scheduling the fade/stop (not after),
    // same reasoning as stopCurrentSource's doc: some native engines can
    // invoke a source's onEnded synchronously from within stop(), and
    // handleEnded's staleness guard needs this.source to already be gone.
    this.cancelPendingCrossfade();
    const source = this.source;
    this.source = null;
    this.startOffsetSeconds = position;
    this.status = 'paused';
    if (source) {
      const when = this.engine.now();
      try {
        source.rampGain({ toValue: 0, atTimeSeconds: when, durationSeconds: PAUSE_RESUME_FADE_SECONDS });
        source.stop(when + PAUSE_RESUME_FADE_SECONDS + STOP_TAIL_SECONDS);
      } catch {
        // A scheduling conflict or bad engine state - fall back to an
        // immediate stop rather than leaving the source playing forever.
        source.stop();
      }
    }
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
   * Sets the gain multiplier applied to this track (normalization, per
   * Stage 5 - relative to the fixed reference loudness target computed
   * during analysis). Takes effect on the currently playing source
   * immediately, and on every source created afterward (seek/resume/pause
   * all tear down and recreate the source - see the class doc - so this
   * has to be remembered and re-applied each time, not just set once).
   */
  setGain(value: number): void {
    this.currentGain = value;
    this.source?.setGain(value * this.masterVolume);
  }

  /**
   * Sets the user-facing master volume [0,1] (e.g. a UI slider) - takes
   * effect on the currently playing source immediately, and on every
   * source created afterward, same as setGain. Independent of setGain's
   * per-track normalization gain; the two multiply together.
   */
  setVolume(value: number): void {
    this.masterVolume = Math.max(0, Math.min(1, value));
    this.source?.setGain(this.currentGain * this.masterVolume);
  }

  getVolume(): number {
    return this.masterVolume;
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
    this.cancelPendingCrossfade();
    const oldSource = this.source;
    this.source = null;
    oldSource?.stop();
  }

  /**
   * Any explicit pause/seek/stop/reload during a pending crossfade (see
   * crossfadeTo) cancels the whole transition, not just the outgoing
   * source - without this, the incoming source scheduled by crossfadeTo
   * would keep playing/ramping in the background with nothing tracking
   * it, and could resurface later (e.g. resuming playback on the wrong
   * track) once its own scheduled stop or natural end eventually fires.
   */
  private cancelPendingCrossfade(): void {
    if (!this.pendingCrossfade) return;
    const pending = this.pendingCrossfade;
    this.pendingCrossfade = null;
    pending.source.stop();
  }

  /**
   * Schedules a volume-only crossfade into nextDecoded per plan, on top of
   * the track already playing: a new source for nextDecoded starts at
   * plan.incomingStartSeconds, at rate 1, essentially immediately ("little
   * to no delay" - no ramp/wait phase this round, see computeTransitionPlan's
   * doc), while the outgoing source's gain fades out - both at rate 1
   * throughout, no tempo matching.
   *
   * Returns false (no-op) if there's nothing currently playing to
   * transition from - callers should fall back to a hard cut in that case,
   * same as an exhausted preload.
   *
   * Doesn't swap this.decoded/this.source over immediately - that happens
   * in handleEnded once the outgoing source's scheduled stop() (below)
   * actually fires, so getState() keeps reporting the outgoing track's own
   * position for as long as it's still the audible "current" track.
   */
  crossfadeTo(nextDecoded: DecodedAudio, plan: TransitionPlan, nextGain: number): boolean {
    if (this.status !== 'playing' || !this.source || !this.decoded) {
      return false;
    }
    // A second crossfade request while one's already in flight (e.g. rapid
    // manual next/previous presses each scheduling their own short
    // crossfade) - cancel the stale pending incoming source first, rather
    // than layering a second scheduled gain automation on top of the first
    // on the same still-live outgoing source, which native engines can
    // reject as a scheduling conflict.
    this.cancelPendingCrossfade();
    const oldSource = this.source;
    const fadeWhen = this.engine.now();

    // Wrapped: if a native engine scheduling call throws partway through
    // (e.g. a real conflict on a param that already has something
    // scheduled on it - seen in practice from a source that was somehow
    // touched twice), the caller must get a clean false back, not a
    // half-scheduled outgoing source paired with a thrown exception. A
    // caller that retried on the very next tick after an uncaught throw
    // would schedule *another* conflicting automation on top of whatever
    // this attempt already managed to apply - repeatedly, since the same
    // conflict would just recur - which reads as random, escalating
    // gain-jump glitches rather than a single clean failure.
    let incomingSource: SourceNode | undefined;
    try {
      // Equal-power, not a straight linear ramp: a linear gain fade spends
      // much of its duration well under its target value (a 20s linear
      // fade-in is still under 10% of target 2s in), which reads as "barely
      // playing" - see equalPowerGain's doc for why. A single rampGain call
      // can't express this curved shape, and calling rampGain repeatedly
      // in a row doesn't work either (each call re-anchors to the *current*
      // live gain value, not to where an already-scheduled ramp would be by
      // then) - rampGainCurve schedules the whole sampled shape in one call.
      //
      // The outgoing curve is scaled by this.currentGain (its own
      // normalization gain, already applied via setGain) - without this,
      // the automation's first sample jumps straight to raw cos(0)=1.0
      // instead of continuing from wherever currentGain actually had it,
      // an audible volume jump right as the fade begins. Both curves are
      // also scaled by masterVolume, same as every other gain applied to a
      // source (setGain/startPlaybackFrom) - a fade shouldn't momentarily
      // ignore the user's volume slider.
      const outgoingGainCurve = sampleEqualPowerGainCurve(GAIN_CURVE_SAMPLE_COUNT, true, plan.fadeDurationSeconds).map(
        (v) => v * this.currentGain * this.masterVolume,
      );
      const incomingGainCurve = sampleEqualPowerGainCurve(GAIN_CURVE_SAMPLE_COUNT, false, plan.fadeDurationSeconds).map(
        (v) => v * nextGain * this.masterVolume,
      );

      oldSource.rampGainCurve(outgoingGainCurve, fadeWhen, plan.fadeDurationSeconds);
      oldSource.stop(fadeWhen + plan.fadeDurationSeconds + STOP_TAIL_SECONDS);

      incomingSource = this.engine.createSource(nextDecoded, () => this.handleEnded(incomingSource as SourceNode));
      incomingSource.setGain(0);
      this.engine.scheduleStart(incomingSource, fadeWhen, plan.incomingStartSeconds);
      incomingSource.rampGainCurve(incomingGainCurve, fadeWhen, plan.fadeDurationSeconds);
    } catch (error) {
      // Best-effort cleanup - don't leave an orphaned, already-started
      // incoming source with nothing tracking it.
      try {
        incomingSource?.stop();
      } catch {
        // Already in a bad state - nothing more we can do about it.
      }
      throw error;
    }

    this.pendingCrossfade = {
      source: incomingSource,
      decoded: nextDecoded,
      startedAtEngineTime: fadeWhen,
      startOffsetSeconds: plan.incomingStartSeconds,
      gain: nextGain,
      rate: 1,
      fadeDurationSeconds: plan.fadeDurationSeconds,
    };
    return true;
  }

  getState(): TrackPlayerState {
    return {
      status: this.status,
      positionSeconds: this.getPositionSeconds(),
      durationSeconds: this.decoded?.durationSeconds ?? 0,
      pendingIncoming: this.pendingCrossfade
        ? {
            positionSeconds: this.getPendingIncomingPositionSeconds(this.pendingCrossfade),
            durationSeconds: this.pendingCrossfade.decoded.durationSeconds,
            fadeDurationSeconds: this.pendingCrossfade.fadeDurationSeconds,
          }
        : null,
    };
  }

  private getPositionSeconds(): number {
    if (this.status !== 'playing') {
      return this.startOffsetSeconds;
    }
    return this.startOffsetSeconds + (this.engine.now() - this.startedAtEngineTime) * this.currentRate;
  }

  private getPendingIncomingPositionSeconds(pending: PendingCrossfade): number {
    // Clamped at 0: the incoming source is scheduled via engine.scheduleStart
    // at startedAtEngineTime, essentially "now" (see crossfadeTo's doc) but
    // not necessarily audible yet the very instant crossfadeTo returns and a
    // caller reads getState() - avoids a fleeting negative position.
    return Math.max(0, pending.startOffsetSeconds + (this.engine.now() - pending.startedAtEngineTime) * pending.rate);
  }

  /**
   * fadeInSeconds > 0 (see PAUSE_RESUME_FADE_SECONDS) starts the source
   * silent and ramps it up to its real gain instead of jumping straight
   * there - used for a resume (via play()) so it doesn't pop back in at
   * full volume; a fresh seek while already playing passes 0 (no fade,
   * matches the instantaneous scrub the UI shows).
   */
  private startPlaybackFrom(offsetSeconds: number, fadeInSeconds = 0): void {
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
    const targetGain = this.currentGain * this.masterVolume;
    if (fadeInSeconds > 0) {
      source.setGain(0);
      source.rampGain({ toValue: targetGain, atTimeSeconds: when, durationSeconds: fadeInSeconds });
    } else {
      source.setGain(targetGain);
    }
    source.setRate(this.currentRate);
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
    // The outgoing source's scheduled stop() (from crossfadeTo) firing -
    // this IS the trustworthy "the transition has completed" signal (more
    // precise than polling engine.now() against a separately-tracked
    // completion time), so swap over to the incoming source that's already
    // been playing/ramped-in throughout the transition, instead of treating
    // this as a natural end - the callers care about advancing their own
    // bookkeeping (see onCrossfadeCompleted), not about starting anything.
    if (this.pendingCrossfade && this.source === source) {
      const pending = this.pendingCrossfade;
      this.pendingCrossfade = null;
      this.source = pending.source;
      this.decoded = pending.decoded;
      this.startedAtEngineTime = pending.startedAtEngineTime;
      this.startOffsetSeconds = pending.startOffsetSeconds;
      this.currentGain = pending.gain;
      this.currentRate = pending.rate;
      this.callbacks.onCrossfadeCompleted?.();
      return;
    }
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
