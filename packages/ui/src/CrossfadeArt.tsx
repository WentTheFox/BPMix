import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

export interface CrossfadeArtProps {
  /** Identity (fileId) of whatever should be in the "current" slot right now. */
  currentTrackKey: string | null;
  currentArtUri: string | null;
  /** [0,1] - how audible the current track is right now (its actual crossfade gain). Drives spin *speed* and the VU meter's knob (a fade indicator, not opacity) - full speed/knob at top near 1, slowing/dropping toward a near-stop as it fades out during an actual crossfade. */
  currentGain: number;
  /** [0,1] - how far into the current track playback has reached. Drives the tonearm's needle position (outer edge at 0, disc center at 1) - NOT reset or hidden by pausing, so a paused tonearm stays parked over wherever it actually stopped instead of jumping back to the edge. Defaults to 0. */
  currentProgress?: number;
  /** Identity (fileId) of whatever should be in the "next" slot right now. */
  nextTrackKey: string | null;
  nextArtUri: string | null;
  /** [0,1] - how audible the next track is right now. Drives spin speed and the VU meter knob the same way, ramping up from a slow idle turn/bottom position as an actual crossfade into it progresses. */
  nextGain: number;
  /** Same as currentProgress, for the next slot's tonearm - 0 whenever the next track hasn't actually started playing yet (i.e. outside an in-progress crossfade), which is most of the time, so its needle stays parked at the outer edge until a crossfade actually brings it in. */
  nextProgress?: number;
  /**
   * Real-time per-band loudness of both slots' own audio signal -
   * @bpmix/core's SourceNode.getFrequencyBands()/PlaylistPlayer.
   * getFrequencyBands(VU_METER_BAND_COUNT), tapped before any fade/volume
   * gain is applied, so it reflects the music's actual dynamics rather
   * than how loud we're currently choosing to play it.
   *
   * A callback, NOT a `bands: number[]` prop - the VU meter polls this
   * itself (internally, on its own interval) and writes straight into its
   * own Animated.Values, never touching React state. An earlier version
   * had the caller poll on an interval and pass the result down as a
   * prop, which meant a full React re-render (cascading through every
   * band column, which each restarted their own animation) 15-somewhat
   * times a second - confirmed on-device as a serious, continuous frame-
   * rate hit (sustained ~24-36fps on a high-refresh-rate phone), not just
   * a one-time cost at a track transition. Optional - a caller with no
   * live metering (or that doesn't want the VU meter reactive) can omit
   * it and the meter just stays at its resting/silent look.
   */
  getAudioBands?: () => { outgoing: number[]; incoming: number[] };
  size?: number;
}

const DEFAULT_SIZE = 84;
const GAP = 16;
/** Duration of one full turn at gain=1 (normal speed). */
const BASE_SPIN_MS = 16000;
/** A disc never fully stops turning - even at gain≈0 it keeps a bare, slow rotation, so "next up" reads as queued rather than broken/frozen. */
const MIN_SPIN_RATE = 0.12;
/**
 * How long the swap/fade transition takes when the current or next slot's
 * content actually changes. Exported so callers can time their own
 * title/"up next" text swap to land in the same beat as the disc (see
 * usePlaybackPersistence's sibling apps, which use this instead of trying
 * to hook into the animation's own completion - a plain setTimeout on this
 * constant is far more robust than threading a callback through Animated's
 * completion handling, which can be interrupted/re-triggered under rapid
 * track changes).
 */
export const CROSSFADE_ART_TRANSITION_MS = 450;
const LABEL_FRACTION = 0.38;
const HOLE_FRACTION = 0.09;
const GROOVE_RING_COUNT = 3;
/** How long the needle takes to react to a progress/lift change. */
const TONEARM_MOVE_MS = 220;
/**
 * Arm length as a fraction of the disc size - long enough that, pivoting
 * at the disc's top-right corner, it can reach all the way to the disc's
 * center (distance size*√0.5). Kept at exactly that length (not longer)
 * because TONEARM_ANGLE_OUTER_DEG/TONEARM_ANGLE_INNER_DEG below are
 * derived FROM it: with a fixed arm length, rotation alone can only reach
 * the two points where a circle of that radius around the pivot crosses
 * whatever target circle (the disc's rim, the label's edge) - not any
 * arbitrary point - so the arm length has to be picked first, and the
 * angles follow from it, not the other way around.
 */
const TONEARM_ARM_LENGTH_FRACTION = Math.SQRT1_2;

/**
 * Rotation (pivoting at the disc's top-right corner, arm body extending
 * left from there) that places the needle tip on the circle of the given
 * radius (as a fraction of disc size, centered on the disc) - the FIRST
 * such crossing while sweeping in from the outer edge (increasing
 * rotation magnitude), which is the one that's actually reachable by
 * continuously turning the arm inward rather than the far side of the
 * disc. Used for both ends of the needle's travel: radiusFraction=0.5
 * (the disc's own rim) for progress 0, and LABEL_FRACTION/2 (the label's
 * edge, where a real record's grooves actually end) for progress 1 - a
 * physical record's playable surface is only that outer band, not the
 * whole disc down to the spindle hole.
 *
 * Derivation: with the pivot at (1,0) and arm length L=√0.5 (unit disc,
 * center at (0.5,0.5)), the radical line between the pivot's swept circle
 * and the target circle of radius r simplifies to y = x - r² (using
 * L²=0.5). Substituting into the pivot circle and solving the resulting
 * quadratic for x, the smaller root is the near/first crossing.
 */
function tonearmAngleForRadius(radiusFraction: number): number {
  const r = radiusFraction;
  const a = 1 + r * r;
  const b = 0.25 + 0.5 * r ** 4;
  const x = (a - Math.sqrt(a * a - 4 * b)) / 2;
  const y = x - r * r;
  return (Math.atan2(-y, 1 - x) * 180) / Math.PI;
}

const TONEARM_ANGLE_OUTER_DEG = tonearmAngleForRadius(0.5);
const TONEARM_ANGLE_INNER_DEG = tonearmAngleForRadius(LABEL_FRACTION / 2);
/**
 * Lifting is a small upward *translation* of the whole arm+pivot, not a
 * rotation - rotating further "up" to lift would, at a shallow
 * (near-progress-0) angle, swing the tip above the disc's top edge and
 * into the title/"up next" text sitting right above it (confirmed
 * on-device). A few px of translateY reads as "picked up" regardless of
 * the current rotation, with no such risk.
 */
const TONEARM_LIFT_FRACTION = 0.06;
/**
 * VU meter flanking each disc, two independent pieces of information side
 * by side rather than layered on top of each other:
 * - A small equalizer-style spread of colored green/yellow/red LED
 *   columns (bottom-up, like a classic hardware meter), one per frequency
 *   band - see VU_METER_BAND_COUNT - showing getAudioBands()'s live
 *   result: the music's actual real-time loudness in that band, bouncing
 *   with the track regardless of fade/crossfade state.
 * - A knob on its own narrow track (VuKnobTrack), a pure fade indicator:
 *   at the top while currentGain/nextGain is ~1 (fully audible), sliding
 *   down to the bottom as the slot pauses or an actual crossfade fades it
 *   out - the same signal driving the disc's spin speed, just rendered as
 *   a marker instead of a rotation rate. Was previously overlaid across
 *   the whole meter's width, which - once that width grew to fit
 *   VU_METER_BAND_COUNT's 8 bands - made the knob read as an oversized bar
 *   rather than a marker (confirmed on-device); a dedicated track keeps it
 *   knob-sized regardless of how wide the band spread gets.
 */
export const VU_METER_BAND_COUNT = 8;
/** How often the VU meter polls getAudioBands() and re-targets its Animated.Values - entirely inside VuMeter's own effect, never via React state/re-render (see CrossfadeArtProps.getAudioBands' doc). */
const VU_POLL_MS = 60;
const VU_BAND_WIDTH = 5;
const VU_BAND_GAP = 2;
const VU_KNOB_TRACK_WIDTH = 6;
const VU_KNOB_TRACK_GAP = 6;
const VU_METER_WIDTH =
  VU_KNOB_TRACK_WIDTH + VU_KNOB_TRACK_GAP + VU_METER_BAND_COUNT * VU_BAND_WIDTH + (VU_METER_BAND_COUNT - 1) * VU_BAND_GAP;
const VU_METER_GAP = 10;
/**
 * Each band column is 3 static color views (a coarse red/yellow/green
 * gradient, painted once) plus a single overlay that slides to cover
 * whatever's above the current level - not, as an earlier version had it,
 * 10 individually opacity-animated LED segments per column. That was 10
 * native view nodes animating per column - 160 across both meters' worth
 * of bands - for a purely decorative element; this is 4 per column (32
 * total) with exactly one Animated.Value doing the work, and the overlay
 * moves via translateY (native-driver-compatible) rather than an animated
 * height, which would have forced it onto the JS thread (the same
 * category of bug LoadingBar had before it was switched off animating
 * `left`).
 */
const VU_BAND_RED_FRACTION = 0.08;
const VU_BAND_YELLOW_FRACTION = 0.17;
/** Never fully opaque - the "unlit" portion should read as dim, not literally gone, so the meter's full scale is still visible at level 0. */
const VU_DIM_OVERLAY_COLOR = 'rgba(8,9,12,0.84)';
const VU_KNOB_HEIGHT = 10;
/**
 * Duration/easing for the knob's and bands' motion. Previously a spring -
 * tuned snappy (low friction, high tension) so it wouldn't average away
 * the fast-changing band data - but a spring's characteristic overshoot
 * read as an unwanted little bounce at the end of every move (confirmed
 * on-device, "I think that's unnecessary"). A plain eased tween has no
 * such overshoot while still arriving quickly.
 *
 * The knob and the bands use different easing, though, not the same
 * constant: the knob only actually retargets on a discrete state change
 * (pause/resume, a crossfade starting/ending), so an ease-in-out reads as
 * a deliberate, settled move. The bands retarget continuously - a new
 * target every ~60ms poll tick - and restarting an ease-in-out's slow
 * start/end from a still-in-flight animation every tick reads as
 * stuttery/janky (confirmed on-device); a linear tween has no start/end
 * hitch to restart into, so it reads as smooth continuous motion instead.
 */
const VU_MOVE_MS = 120;
const VU_KNOB_MOVE_EASING = Easing.inOut(Easing.ease);
const VU_BAND_MOVE_EASING = Easing.linear;

/**
 * Maps a band's magnitude (0-1, from bandsFromByteFrequencyData) to a
 * display fraction. That input is ALREADY on a dB-normalized scale - it's
 * an RMS-style average of AnalyserNode byte-frequency values, themselves a
 * linear remap of [minDecibels, maxDecibels] to [0,255] - so, unlike the
 * old single-value meter (a genuinely linear RMS amplitude that needed its
 * own 20*log10() conversion to reach a dB-ish display scale), applying a
 * log - or even a sqrt - here would be double-converting: a sqrt curve
 * specifically compresses the *top* of the range together, which is
 * exactly where a normally-mastered track's band energy tends to sit most
 * of the time, and made the meter look nearly static (confirmed
 * on-device). A straight clamp leaves the byte-derived scale's own
 * contrast intact.
 */
function audioLevelToFraction(level: number): number {
  return Math.max(0, Math.min(1, level));
}

/** Spin rate is rounded to this granularity before restarting the loop animation - restarting on every ~200ms poll tick's tiny gain fluctuation would look jittery; only a genuinely audible speed change (mostly during an actual crossfade) should visibly re-time it. */
const RATE_BUCKET = 0.2;
/** How many full turns to schedule per animation leg - just needs to be long enough that a rate-bucket change (or a lap completing) is very unlikely to still be running the same leg by the time the next one's scheduled; each leg's actual duration still scales with the current rate. */
const TURNS_PER_LEG = 200;

function useSpin(rate: number): Animated.AnimatedInterpolation<string> {
  // Degrees, unbounded (not normalized to [0,1] and reset every lap) - a
  // rate change re-times the animation but always continues forward from
  // wherever the disc's angle already is, instead of snapping back to 0.
  // Resetting the value on every rate-bucket change (which happens
  // constantly while a track is loading, as gain/isPlaying settle) is
  // exactly what caused the disc to visibly jump back to "straight up"
  // and restart mid-spin.
  const rotationDeg = useRef(new Animated.Value(0)).current;
  // rate<=0 means "not audible at all" (nothing playing) - genuinely stop
  // turning rather than applying the MIN_SPIN_RATE floor, which is only
  // meant to keep an audible-but-quiet disc from looking frozen/broken.
  const bucketedRate = rate <= 0 ? 0 : Math.max(MIN_SPIN_RATE, Math.round(rate / RATE_BUCKET) * RATE_BUCKET);
  useEffect(() => {
    if (bucketedRate <= 0) {
      // Freezes wherever the last leg's stop() below already left it -
      // reads as the record actually coming to a stop, not resetting.
      return;
    }
    const legDegrees = TURNS_PER_LEG * 360;
    const legDurationMs = (BASE_SPIN_MS / bucketedRate) * TURNS_PER_LEG;
    let anim: Animated.CompositeAnimation | null = null;
    let cancelled = false;
    const runLeg = () => {
      if (cancelled) return;
      // Animated.Value has no public synchronous getter - reading the
      // private field is a well-worn, deliberate exception here (there's
      // no other way to continue an in-flight rotation from its current
      // angle instead of resetting it).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = (rotationDeg as any)._value ?? 0;
      anim = Animated.timing(rotationDeg, {
        toValue: current + legDegrees,
        duration: legDurationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      });
      anim.start(({ finished }) => {
        if (finished) runLeg();
      });
    };
    runLeg();
    return () => {
      cancelled = true;
      anim?.stop();
    };
  }, [bucketedRate, rotationDeg]);
  return rotationDeg.interpolate({ inputRange: [0, 360], outputRange: ['0deg', '360deg'], extrapolate: 'extend' });
}

function centeredCircleStyle(discSize: number, circleSize: number): { width: number; height: number; borderRadius: number; top: number; left: number } {
  return {
    width: circleSize,
    height: circleSize,
    borderRadius: circleSize / 2,
    top: (discSize - circleSize) / 2,
    left: (discSize - circleSize) / 2,
  };
}

function VinylDisc({
  artUri,
  rate,
  size,
  opacity = 1,
  translateX,
}: {
  artUri: string | null;
  rate: number;
  size: number;
  opacity?: Animated.Value | number;
  translateX?: Animated.Value | number;
}) {
  const spin = useSpin(rate);
  const boxStyle = { width: size, height: size, borderRadius: size / 2 };
  // The placeholder stays underneath throughout (disc is never literally
  // empty), and the art image cross-dissolves in on top of it once it
  // resolves - useCoverArt already starts fetching well ahead of when a
  // disc actually needs to show it (as soon as the next track is known,
  // not when this component mounts), so this only actually animates
  // anything on the rarer case the fetch hasn't resolved yet by the time
  // the disc becomes visible.
  const artOpacity = useRef(new Animated.Value(artUri ? 1 : 0)).current;
  useEffect(() => {
    if (artUri) {
      Animated.timing(artOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    } else {
      artOpacity.setValue(0);
    }
  }, [artUri, artOpacity]);
  // Groove rings sit between the label and the disc's outer edge, evenly
  // spaced - purely decorative, drawn as plain bordered circles rather than
  // an actual radial texture. This is also the record's actual playable
  // surface (see tonearmAngleForRadius's doc) - a real record has no art
  // printed on the vinyl itself out here, just grooves over plain black
  // vinyl, so the art only appears on the label (below) instead of behind
  // these rings.
  const grooveRadii = Array.from({ length: GROOVE_RING_COUNT }, (_, i) => {
    const t = (i + 1) / (GROOVE_RING_COUNT + 1);
    return size * LABEL_FRACTION + (size - size * LABEL_FRACTION) * t;
  });
  const labelCircleStyle = centeredCircleStyle(size, size * LABEL_FRACTION);
  return (
    <Animated.View style={[styles.layer, boxStyle, { opacity, transform: [{ translateX: translateX ?? 0 }, { rotate: spin }] }]}>
      <View style={[styles.layer, styles.vinylBody, boxStyle]} />
      {grooveRadii.map((diameter, i) => (
        <View key={i} style={[styles.layer, styles.groove, centeredCircleStyle(size, diameter)]} />
      ))}
      <View style={[styles.layer, styles.labelBase, labelCircleStyle]} />
      {artUri && <Animated.Image source={{ uri: artUri }} style={[styles.layer, labelCircleStyle, { opacity: artOpacity }]} />}
      <View style={[styles.layer, styles.labelRim, labelCircleStyle]} />
      <View style={[styles.layer, styles.hole, centeredCircleStyle(size, size * HOLE_FRACTION)]} />
    </Animated.View>
  );
}

/**
 * The needle/tonearm resting over a slot - one per slot (current, next),
 * NOT one per VinylDisc instance, so it doesn't spin with the record and
 * doesn't multiply into several arms while outgoing/incoming ghost discs
 * are mounted mid-transition. Pivots at its own top-right corner, flush
 * with the disc's edge. Its rotation continuously tracks `progress` (see
 * CrossfadeArtProps' doc) - starting near the rim, sweeping in toward the
 * center as the track plays, same as a real record - independent of
 * `down`, which only lifts the whole assembly a few px clear of the disc
 * (see TONEARM_LIFT_FRACTION's doc) rather than resetting its position, so
 * a paused tonearm stays parked over wherever it actually stopped.
 */
function Tonearm({ down, progress, size }: { down: boolean; progress: number; size: number }) {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const targetDeg = TONEARM_ANGLE_OUTER_DEG + (TONEARM_ANGLE_INNER_DEG - TONEARM_ANGLE_OUTER_DEG) * clampedProgress;
  const rotationDeg = useRef(new Animated.Value(targetDeg)).current;
  useEffect(() => {
    Animated.timing(rotationDeg, { toValue: targetDeg, duration: TONEARM_MOVE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [targetDeg, rotationDeg]);
  const rotate = rotationDeg.interpolate({ inputRange: [-180, 180], outputRange: ['-180deg', '180deg'] });

  const lift = useRef(new Animated.Value(down ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(lift, { toValue: down ? 0 : 1, duration: TONEARM_MOVE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [down, lift]);
  const translateY = lift.interpolate({ inputRange: [0, 1], outputRange: [0, -size * TONEARM_LIFT_FRACTION] });

  const armLength = size * TONEARM_ARM_LENGTH_FRACTION;
  return (
    <Animated.View style={[styles.tonearmMount, { transform: [{ translateY }] }]} pointerEvents="none">
      <View style={styles.tonearmPivot} />
      <Animated.View style={[styles.tonearmArm, { width: armLength, transform: [{ rotate }] }]}>
        <View style={styles.tonearmNeedle} />
      </Animated.View>
    </Animated.View>
  );
}

/**
 * `gain` is the crossfade audibility fraction (currentGain/nextGain - 0
 * when paused/faded out, ~1 while fully audible) - drives only the knob.
 * `audioLevel` is the track's real-time raw RMS - drives only the colored
 * fill. Two Animated.Values because they mean different things and move on
 * different rhythms (the knob only really moves during a pause/crossfade;
 * the fill is meant to bounce continuously with the music).
 */
/** One frequency band's own LED column - a vertically-stacked set of segments lit bottom-up to `level` (already mapped to [0,1] display fraction). */
/** `level` is an externally-owned, externally-driven Animated.Value (see CrossfadeArt's own polling effect) - this component never touches its target itself, just renders it. */
function VuBandColumn({ level, size }: { level: Animated.Value; size: number }) {
  // The dim overlay is full-column-height, anchored at the top, and slides
  // straight UP by its own height as level goes 0->1 - at level 0 it sits
  // in place covering everything, at level 1 it's shifted entirely above
  // the (overflow: hidden) column and covers nothing. At a middle level,
  // only its bottom portion remains inside the column's bounds, so what's
  // actually visible is a dim band from the top down to (1-level)*size -
  // exactly the "unlit" portion, without animating height directly.
  const translateY = level.interpolate({ inputRange: [0, 1], outputRange: [0, -size] });
  const redHeight = size * VU_BAND_RED_FRACTION;
  const yellowHeight = size * VU_BAND_YELLOW_FRACTION;
  const greenHeight = size - redHeight - yellowHeight;
  return (
    <View style={{ width: VU_BAND_WIDTH, height: size, borderRadius: 1.5, overflow: 'hidden' }}>
      <View style={[styles.vuBandColor, { top: 0, height: redHeight, backgroundColor: '#ef4444' }]} />
      <View style={[styles.vuBandColor, { top: redHeight, height: yellowHeight, backgroundColor: '#f59e0b' }]} />
      <View style={[styles.vuBandColor, { top: redHeight + yellowHeight, height: greenHeight, backgroundColor: '#22c55e' }]} />
      <Animated.View style={[styles.vuBandDim, { height: size, transform: [{ translateY }] }]} />
    </View>
  );
}

/** The fade-indicator knob's own narrow track, separate from the band columns so its width doesn't depend on how many bands there are. */
function VuKnobTrack({ gain, size }: { gain: number; size: number }) {
  const knobTarget = Math.max(0, Math.min(1, gain));
  const knobLevel = useRef(new Animated.Value(knobTarget)).current;
  useEffect(() => {
    Animated.timing(knobLevel, { toValue: knobTarget, duration: VU_MOVE_MS, easing: VU_KNOB_MOVE_EASING, useNativeDriver: true }).start();
    // Only the computed target should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knobTarget, knobLevel]);
  // knobLevel=0 knob center sits at the very bottom, 1 at the very top.
  const translateY = knobLevel.interpolate({ inputRange: [0, 1], outputRange: [size - VU_KNOB_HEIGHT / 2, -VU_KNOB_HEIGHT / 2] });
  return (
    <View style={{ width: VU_KNOB_TRACK_WIDTH, height: size }}>
      <View style={styles.vuKnobTrackLine} />
      <Animated.View style={[styles.vuKnob, { height: VU_KNOB_HEIGHT, transform: [{ translateY }] }]} />
    </View>
  );
}

function VuMeter({ gain, bandLevels, size, side }: { gain: number; bandLevels: Animated.Value[]; size: number; side: 'left' | 'right' }) {
  const bandRow = (
    <View style={styles.vuBandRow}>
      {bandLevels.map((level, band) => (
        <VuBandColumn key={band} level={level} size={size} />
      ))}
    </View>
  );
  const knobTrack = <VuKnobTrack gain={gain} size={size} />;
  return (
    <View
      style={[styles.vuMeter, { width: VU_METER_WIDTH, height: size, gap: VU_KNOB_TRACK_GAP }, side === 'left' ? { left: 0 } : { right: 0 }]}
      pointerEvents="none"
    >
      {/* Knob track sits on the outer edge (away from the disc) on both sides, for a symmetric look. */}
      {side === 'left' ? (
        <>
          {knobTrack}
          {bandRow}
        </>
      ) : (
        <>
          {bandRow}
          {knobTrack}
        </>
      )}
    </View>
  );
}

interface DiscSnapshot {
  key: string;
  artUri: string | null;
}

interface DisplayedState {
  currentKey: string | null;
  currentArt: string | null;
  nextKey: string | null;
  nextArt: string | null;
}

/**
 * The current and next tracks' cover art, each circle-cropped like a
 * record - center label, spindle hole, and a few faint groove rings over
 * the art - shown side by side. Audibility is conveyed by spin *speed*
 * instead of opacity: the current disc spins at normal speed and slows as
 * an actual crossfade fades it out, the next disc idles at a slow turn and
 * speeds up as a crossfade brings it in - both driven by the same
 * equal-power gain curve powering the real audio fade (see App.tsx's
 * outgoingGain/incomingGain, sampled from the same equalPowerGain() call
 * SourceNode.rampGainCurve uses for real playback). The same two gain
 * values also drive the fade-indicator knob on a small VU meter flanking
 * each disc (see VuMeter) - same idea as the spin, rendered as a marker
 * position instead of a rotation rate. That meter's colored fill is a
 * separate signal (getAudioBands()'s live per-band loudness), independent
 * of fade state.
 *
 * What's actually on screen (`displayed`) only changes via one of two
 * animated transitions, never a silent prop-driven pop:
 * - Natural progression (currentTrackKey becomes whatever nextTrackKey
 *   already was): the next-slot disc - already fully loaded and visible -
 *   slides left into the current slot while the old current disc fades out
 *   in place. Nothing needs to wait on new data for this to look smooth.
 * - Any other current-slot change (a manual track pick, restoring on
 *   launch, ...): the old current disc fades out while the new one
 *   (rendered from the live props, not yet "displayed") fades in over it,
 *   same timing, just no slide since there's no "next" continuity to
 *   animate from.
 * A next-slot change (only picked up once idle - never mid-transition,
 * which would put three discs on screen at once) always just fades in
 * place, independent of whichever animation the current slot is doing.
 *
 * State commits (what `displayed` actually becomes) are scheduled with a
 * plain setTimeout(CROSSFADE_ART_TRANSITION_MS), not the Animated
 * completion callback - deliberately: an Animated .start(callback) can
 * report finished:false if anything re-triggers the same value before it
 * naturally completes, which would otherwise leave the commit (and the
 * component out of "transitioning" state) stuck indefinitely. The
 * setTimeout still lines up with the animation's own duration, so visually
 * it lands at the same moment either way.
 */
export function CrossfadeArt({
  currentTrackKey,
  currentArtUri,
  currentGain,
  currentProgress = 0,
  nextTrackKey,
  nextArtUri,
  nextGain,
  nextProgress = 0,
  getAudioBands,
  size = DEFAULT_SIZE,
}: CrossfadeArtProps): React.JSX.Element {
  const [displayed, setDisplayed] = useState<DisplayedState>({
    currentKey: currentTrackKey,
    currentArt: currentArtUri,
    nextKey: nextTrackKey,
    nextArt: nextArtUri,
  });
  const [outgoing, setOutgoing] = useState<DiscSnapshot | null>(null);
  const [incoming, setIncoming] = useState<DiscSnapshot | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  const slideX = useRef(new Animated.Value(0)).current;
  const outgoingOpacity = useRef(new Animated.Value(0)).current;
  const incomingOpacity = useRef(new Animated.Value(0)).current;
  const nextOpacity = useRef(new Animated.Value(nextTrackKey ? 1 : 0)).current;

  // VU meter band levels - owned here (not per-VuMeter) so a single poll
  // tick updates both sides together. Created once and mutated in place by
  // the effect below via Animated.timing().start(), never via setState -
  // see CrossfadeArtProps.getAudioBands' doc for why that distinction
  // matters (a naive setState-per-tick version was a confirmed, serious,
  // continuous frame-rate regression on-device, not just a one-off cost).
  const currentBandLevels = useRef(Array.from({ length: VU_METER_BAND_COUNT }, () => new Animated.Value(0))).current;
  const nextBandLevels = useRef(Array.from({ length: VU_METER_BAND_COUNT }, () => new Animated.Value(0))).current;
  const getAudioBandsRef = useRef(getAudioBands);
  useEffect(() => {
    getAudioBandsRef.current = getAudioBands;
  }, [getAudioBands]);
  useEffect(() => {
    const interval = setInterval(() => {
      const result = getAudioBandsRef.current?.();
      for (let i = 0; i < VU_METER_BAND_COUNT; i++) {
        const currentLevel = currentBandLevels[i];
        const nextLevel = nextBandLevels[i];
        if (!currentLevel || !nextLevel) continue;
        const outgoingTarget = audioLevelToFraction(result?.outgoing[i] ?? 0);
        const incomingTarget = audioLevelToFraction(result?.incoming[i] ?? 0);
        Animated.timing(currentLevel, { toValue: outgoingTarget, duration: VU_MOVE_MS, easing: VU_BAND_MOVE_EASING, useNativeDriver: true }).start();
        Animated.timing(nextLevel, { toValue: incomingTarget, duration: VU_MOVE_MS, easing: VU_BAND_MOVE_EASING, useNativeDriver: true }).start();
      }
    }, VU_POLL_MS);
    return () => clearInterval(interval);
    // Mount-once - getAudioBandsRef sidesteps needing getAudioBands (or the
    // Animated.Value arrays, stable for this component's lifetime) as deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The current slot changing - the one animated transition that can
  // involve a slide (natural progression) as well as a fade.
  useEffect(() => {
    if (currentTrackKey === displayed.currentKey) return;
    if (currentTrackKey == null) {
      setDisplayed((d) => ({ ...d, currentKey: null, currentArt: null }));
      return;
    }
    const isNaturalProgression = currentTrackKey === displayed.nextKey;
    setTransitioning(true);
    setOutgoing(displayed.currentKey ? { key: displayed.currentKey, artUri: displayed.currentArt } : null);
    outgoingOpacity.setValue(1);
    Animated.timing(outgoingOpacity, { toValue: 0, duration: CROSSFADE_ART_TRANSITION_MS, easing: Easing.linear, useNativeDriver: true }).start();

    if (isNaturalProgression) {
      setIncoming(null);
      // The sliding disc IS the next-slot disc (already rendered at the
      // right slot's fixed position) - translateX 0 is "still at the
      // right slot", so it animates to -(size+GAP) (one slot-width plus
      // the gap, leftward) to land exactly on the left slot.
      slideX.setValue(0);
      Animated.timing(slideX, {
        toValue: -(size + GAP),
        duration: CROSSFADE_ART_TRANSITION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      setIncoming({ key: currentTrackKey, artUri: currentArtUri });
      incomingOpacity.setValue(0);
      Animated.timing(incomingOpacity, { toValue: 1, duration: CROSSFADE_ART_TRANSITION_MS, easing: Easing.linear, useNativeDriver: true }).start();
    }

    const timeout = setTimeout(() => {
      if (isNaturalProgression) {
        // Resets the now-empty next slot's disc back to its own resting
        // position/hidden state - left as-is otherwise, it'd sit stuck at
        // the left (current) slot's offset, visible, until (if ever)
        // another slide transition reset it.
        slideX.setValue(0);
        nextOpacity.setValue(0);
        setDisplayed((d) => ({ currentKey: currentTrackKey, currentArt: d.nextArt, nextKey: null, nextArt: null }));
      } else {
        setDisplayed((d) => ({ ...d, currentKey: currentTrackKey, currentArt: currentArtUri }));
      }
      setOutgoing(null);
      setIncoming(null);
      setTransitioning(false);
    }, CROSSFADE_ART_TRANSITION_MS);
    return () => clearTimeout(timeout);
    // Only currentTrackKey should retrigger this - the rest are read at
    // the moment it fires, not reactive dependencies of their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackKey]);

  // Freshest art for whichever key is already settled as current (e.g. the
  // fetch resolves after a swap already landed) - no transition animation
  // needed for this, VinylDisc's own artOpacity already cross-dissolves it.
  useEffect(() => {
    if (transitioning) return;
    if (currentTrackKey === displayed.currentKey && currentArtUri !== displayed.currentArt) {
      setDisplayed((d) => ({ ...d, currentArt: currentArtUri }));
    }
  }, [currentArtUri, currentTrackKey, displayed.currentKey, displayed.currentArt, transitioning]);

  // The next slot changing - only while idle (never mid-transition, which
  // would put three discs on screen at once instead of two).
  useEffect(() => {
    if (transitioning) return;
    if (nextTrackKey === displayed.nextKey) {
      if (nextArtUri !== displayed.nextArt) {
        setDisplayed((d) => ({ ...d, nextArt: nextArtUri }));
      }
      return;
    }
    setDisplayed((d) => ({ ...d, nextKey: nextTrackKey, nextArt: nextArtUri }));
    nextOpacity.setValue(0);
    Animated.timing(nextOpacity, { toValue: 1, duration: CROSSFADE_ART_TRANSITION_MS, easing: Easing.linear, useNativeDriver: true }).start();
    // Only nextTrackKey/transitioning should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextTrackKey, transitioning]);

  const discsOffset = VU_METER_WIDTH + VU_METER_GAP;
  const containerStyle = { width: discsOffset * 2 + size * 2 + GAP, height: size };
  const boxStyle = { width: size, height: size };

  return (
    <View style={[styles.row, containerStyle]}>
      <VuMeter gain={currentGain} bandLevels={currentBandLevels} size={size} side="left" />
      <View style={[styles.slot, boxStyle, { left: discsOffset }]}>
        {!transitioning && <VinylDisc artUri={displayed.currentArt} rate={currentGain} size={size} />}
        {outgoing && <VinylDisc artUri={outgoing.artUri} rate={1} size={size} opacity={outgoingOpacity} />}
        {incoming && <VinylDisc artUri={incoming.artUri} rate={currentGain} size={size} opacity={incomingOpacity} />}
        {/* Forced up (`!transitioning &&`) for the swap/fade's whole duration, not just while a disc is actually mid-slide - the needle has to be clear before a disc starts moving under it, not just while it's moving. */}
        <Tonearm down={!transitioning && currentGain > 0} progress={currentProgress} size={size} />
      </View>
      <View style={[styles.slot, boxStyle, { left: discsOffset + size + GAP }]}>
        <VinylDisc artUri={displayed.nextArt} rate={nextGain} size={size} opacity={nextOpacity} translateX={slideX} />
        <Tonearm down={!transitioning && nextGain > 0} progress={nextProgress} size={size} />
      </View>
      <VuMeter gain={nextGain} bandLevels={nextBandLevels} size={size} side="right" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: 'center',
    marginVertical: 8,
  },
  slot: {
    position: 'absolute',
    top: 0,
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  // Plain black vinyl - the disc's actual base color, visible everywhere
  // outside the label (the grooved area has no art on a real record).
  vinylBody: {
    backgroundColor: '#161616',
  },
  groove: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  // Sits under the art (which is cropped to this same circle) so a track
  // with no art yet still shows a plain label instead of bare vinyl body
  // poking through the label's own footprint.
  labelBase: {
    backgroundColor: '#2a2a2a',
  },
  // A thin ring on top of the art marking the label's edge, like a real
  // paper label's visible border against the vinyl - a plain fill here
  // (like the old design) would have hidden the art underneath instead of
  // just framing it.
  labelRim: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.5)',
  },
  hole: {
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  tonearmMount: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 1,
    height: 1,
  },
  tonearmPivot: {
    position: 'absolute',
    top: -3,
    left: -3,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#1f2937',
  },
  tonearmArm: {
    position: 'absolute',
    top: -1.5,
    right: 0,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#374151',
    // Pivots around its own top-right corner (the mount point above), not
    // its center - that's what makes the free end sweep an arc onto/off of
    // the disc instead of rotating in place.
    transformOrigin: ['100%', '50%', 0],
  },
  tonearmNeedle: {
    position: 'absolute',
    top: -2,
    left: -2.5,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#111827',
  },
  vuMeter: {
    position: 'absolute',
    top: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  vuBandRow: {
    flexDirection: 'row',
    gap: VU_BAND_GAP,
  },
  vuBandColor: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  vuBandDim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: VU_DIM_OVERLAY_COLOR,
  },
  vuKnobTrackLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  vuKnob: {
    position: 'absolute',
    left: -3,
    right: -3,
    borderRadius: 3,
    backgroundColor: '#f8fafc',
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.45)',
  },
});
