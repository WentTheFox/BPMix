import { useEffect, useId, useRef } from 'react';
import { Animated, Easing, Image, Platform, StyleSheet, View } from 'react-native';
import { useSpin } from './spin/useSpin';
import type { Colors } from './theme';

/**
 * The spin layer must be a plain View on web, not Animated.View - useSpin.web.ts's
 * result is a static-per-render CSS `animationKeyframes` object (no
 * Animated.Value involved at all, unlike useSpin.ts's native interpolation),
 * and react-native-web's Animated.View applies style props via direct DOM
 * assignment rather than running them through the StyleSheet compiler step
 * that turns `animationKeyframes` into a real `@keyframes` rule with a
 * matching `animation-name` - confirmed live: animation-duration/-delay/
 * -timing-function/-iteration-count all landed in the DOM, but animation-name
 * never did, so the discs sat frozen. Native still needs the real
 * Animated.View here for its Animated.Value-driven rotation.
 */
const SpinLayer = Platform.OS === 'web' ? View : Animated.View;

export interface CrossfadeArtProps {
  colors: Colors;
  currentArtUri: string | null;
  /** [0,1] - how audible the current track is right now (its actual crossfade gain). Drives only the tonearm's lift (down once genuinely audible) - disc rotation itself tracks currentProgress/currentTurnsPerSecond instead, not this. */
  currentGain: number;
  /** [0,1] - how far into the current track playback has reached. Anchors the disc's own rotation and drives the tonearm's needle position (outer edge at 0, disc center at 1) - NOT reset or hidden by pausing, so a paused tonearm stays parked over wherever it actually stopped instead of jumping back to the edge. Defaults to 0. */
  currentProgress?: number;
  /**
   * Real full turns per second the current disc should be continuously
   * spinning at right now (0 while paused) - TURNS_PER_SONG / durationSeconds
   * for ordinary playback. Drives the actual spin animation (see useSpin) as
   * a continuous native/CSS animation rather than a per-tick retarget;
   * currentProgress only anchors its starting angle whenever this changes
   * (e.g. right after a seek, so the disc jumps straight to the new angle
   * instead of animating through the skipped stretch). Defaults to 0
   * (frozen).
   */
  currentTurnsPerSecond?: number;
  /**
   * True while currentProgress is a live seek-bar drag preview rather than
   * an ordinary ~200ms poll-tick update - see Tonearm's own doc for why
   * that distinction matters to how it animates. Defaults to false.
   */
  currentSeeking?: boolean;
  /**
   * The upcoming track's cover art, cross-dissolved in on top of the same
   * disc as nextGain rises - null whenever nothing's crossfading in (most
   * of the time). There is deliberately no second disc/tonearm for the
   * next track any more - only a single physical disc is ever shown; a
   * separate next-slot disc plus its own slide/fade swap animation looked
   * like more UI flicker than the "what's coming up" preview was worth
   * (see NowPlayingScreen's own "Up next" text for that instead).
   */
  nextArtUri?: string | null;
  /** [0,1] - how audible the incoming track is right now, i.e. exactly how far the crossfade has progressed. Directly drives the incoming art's cross-dissolve opacity on top of the current art (0 = fully hidden, 1 = fully covering it) - the visual fade always matches the real audio fade curve exactly, no separate timing to keep in sync. Also what tells the tonearm a crossfade is actually in flight (see Tonearm's own doc). Defaults to 0. */
  nextGain?: number;
  size?: number;
}

const DEFAULT_SIZE = 84;
/**
 * How long to debounce the "settled" track title/"up next" text before
 * committing to a track change (see each app's useSettledKey-equivalent
 * effect) - historically also timed CrossfadeArt's own disc swap/fade
 * animation, back when there was one to keep in sync with; kept here as
 * the single source of that timing even though the disc itself no longer
 * has any transition of its own to match (a rapid run of manual skips
 * flickering the title through every intermediate track was the actual
 * problem this debounce solves, independent of the disc).
 */
export const CROSSFADE_ART_TRANSITION_MS = 450;
// Bumped up from 0.38 now that there's only one disc to look at (more
// screen real estate to give the actual album art) - TONEARM_ANGLE_INNER_DEG
// and the groove ring positions below are both derived FROM this constant
// (see tonearmAngleForRadius/grooveRingDiameterFraction), so the tonearm's
// resting angle over the label edge and the decorative grooves move
// outward with it automatically; nothing else needed updating by hand.
const LABEL_FRACTION = 0.5;
const HOLE_FRACTION = 0.09;
const GROOVE_RING_COUNT = 3;
/** Diameter fraction (of disc size) of groove ring index `i` (0 = innermost, evenly spaced out to the disc's own edge) - shared by VinylDisc's rendering and OUTER_GROOVE_DIAMETER_FRACTION below so they can't drift apart. */
function grooveRingDiameterFraction(i: number): number {
  const t = (i + 1) / (GROOVE_RING_COUNT + 1);
  return LABEL_FRACTION + (1 - LABEL_FRACTION) * t;
}
/**
 * Diameter fraction of the outermost decorative groove ring. The tonearm's
 * outer resting position (see TONEARM_ANGLE_OUTER_DEG) targets this ring,
 * not the disc's own bounding-box edge (radiusFraction 0.5): vinylBody's
 * color (#161616) is barely distinguishable from the page background, so
 * the ~15% margin between the outermost ring and the disc's true edge
 * reads as empty space - a needle resting there looked visually
 * disconnected from the disc entirely ("stuck behind/above the disc",
 * confirmed on-device), even though it was geometrically correct. Resting
 * on the last visible groove instead makes the needle read as touching
 * the record.
 */
const OUTER_GROOVE_DIAMETER_FRACTION = grooveRingDiameterFraction(GROOVE_RING_COUNT - 1);
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
 * disc. Used for both ends of the needle's travel: OUTER_GROOVE_DIAMETER_FRACTION/2
 * (the outermost visible groove ring, not the disc's own bounding-box
 * edge - see that constant's doc for why) for progress 0, and
 * LABEL_FRACTION/2 (the label's edge, where a real record's grooves
 * actually end) for progress 1 - a physical record's playable surface is
 * only that outer band, not the whole disc down to the spindle hole.
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

const TONEARM_ANGLE_OUTER_DEG = tonearmAngleForRadius(OUTER_GROOVE_DIAMETER_FRACTION / 2);
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

function centeredCircleStyle(discSize: number, circleSize: number): { width: number; height: number; borderRadius: number; top: number; left: number } {
  return {
    width: circleSize,
    height: circleSize,
    borderRadius: circleSize / 2,
    top: (discSize - circleSize) / 2,
    left: (discSize - circleSize) / 2,
  };
}

/**
 * The needle/tonearm resting over the disc. Pivots at its own top-right
 * corner, flush with the disc's edge. Its rotation continuously tracks
 * `progress` (see CrossfadeArtProps' doc) - starting near the rim, sweeping
 * in toward the center as the track plays, same as a real record -
 * independent of `down`, which only lifts the whole assembly a few px
 * clear of the disc (see TONEARM_LIFT_FRACTION's doc) rather than resetting
 * its position, so a paused tonearm stays parked over wherever it actually
 * stopped.
 *
 * While `crossfading` (see CrossfadeArtProps.nextGain's doc), the target
 * angle is forced back to progress 0 (the outer edge) regardless of the
 * real `progress` value - the same real record player behavior this whole
 * component is modeled on: the arm lifts and swings back out before a new
 * record starts, rather than staying parked wherever the outgoing track
 * happened to be. Uses the exact same eased tween as any other progress
 * change, just retargeted.
 *
 * `seeking` (see CrossfadeArtProps.currentSeeking's doc) doesn't change the
 * progress-to-angle mapping at all - only how the needle gets there.
 * Normal playback re-targets the angle roughly once per ~200ms poll tick,
 * so easing each of those hops over TONEARM_MOVE_MS reads as one continuous
 * inward sweep. A seek-bar drag instead fires this far more often (every
 * touch-move tick, no debounce - see SeekBar's onPreview), and re-triggering
 * that same eased tween on every one of those ticks would have the needle
 * perpetually chasing a moving target several ticks behind the finger
 * instead of tracking it. While seeking, the angle jumps straight to each
 * new target instead - still the exact same eased progress-to-angle curve
 * below, just applied instantly rather than smoothed toward over time.
 */
function Tonearm({
  down,
  progress,
  crossfading,
  seeking,
  size,
}: {
  down: boolean;
  progress: number;
  crossfading: boolean;
  seeking: boolean;
  size: number;
}) {
  const clampedProgress = crossfading ? 0 : Math.max(0, Math.min(1, progress));
  // Eased rather than linear - same start (outer rim) and end (label edge)
  // positions, but a real record's constant angular velocity means the
  // needle covers the same time span in a smaller, faster-shrinking arc as
  // it nears the center, so it visibly picks up speed moving inward
  // instead of crossing the disc at a constant rate.
  const easedProgress = Easing.in(Easing.cubic)(clampedProgress);
  const targetDeg = TONEARM_ANGLE_OUTER_DEG + (TONEARM_ANGLE_INNER_DEG - TONEARM_ANGLE_OUTER_DEG) * easedProgress;
  const rotationDeg = useRef(new Animated.Value(targetDeg)).current;
  useEffect(() => {
    if (seeking) {
      rotationDeg.stopAnimation();
      rotationDeg.setValue(targetDeg);
      return;
    }
    Animated.timing(rotationDeg, { toValue: targetDeg, duration: TONEARM_MOVE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [targetDeg, rotationDeg, seeking]);
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
 * The current track's cover art, circle-cropped like a record - center
 * label, spindle hole, and a few faint groove rings over the art. Rotation
 * is a pure function of currentProgress/currentTurnsPerSecond (see
 * spinConstants.ts's TURNS_PER_SONG) rather than an open-ended,
 * audibility-driven animation - always exactly consistent with playback
 * position, and freezes for free on pause. There is only ever this one
 * disc: a real crossfade cross-dissolves the incoming track's art directly
 * on top of it (opacity tracking nextGain, so the visual fade always
 * matches the real audio fade exactly) and the tonearm sweeps back to the
 * outer edge, rather than showing a second disc sliding/fading in - see
 * CrossfadeArtProps' own docs for why.
 */
export function CrossfadeArt({
  colors,
  currentArtUri,
  currentGain,
  currentProgress = 0,
  currentTurnsPerSecond = 0,
  currentSeeking = false,
  nextArtUri = null,
  nextGain = 0,
  size = DEFAULT_SIZE,
}: CrossfadeArtProps): React.JSX.Element {
  const spinId = useId();
  const spinStyle = useSpin(currentTurnsPerSecond, currentProgress, spinId);
  const boxStyle = { width: size, height: size, borderRadius: size / 2 };
  const grooveRadii = Array.from({ length: GROOVE_RING_COUNT }, (_, i) => size * grooveRingDiameterFraction(i));
  const labelCircleStyle = centeredCircleStyle(size, size * LABEL_FRACTION);
  const crossfading = nextGain > 0;

  return (
    <View style={[styles.row, boxStyle]}>
      <SpinLayer style={[styles.layer, boxStyle, spinStyle]}>
        <View style={[styles.layer, styles.vinylBody, boxStyle]} />
        {grooveRadii.map((diameter, i) => (
          <View key={i} style={[styles.layer, styles.groove, centeredCircleStyle(size, diameter)]} />
        ))}
        {/* Sits under the art (cropped to this same circle) so a track with no art yet, or art with transparency, shows the accent color instead of bare vinyl poking through. */}
        <View style={[styles.layer, labelCircleStyle, { backgroundColor: colors.accent }]} />
        {currentArtUri && <Image source={{ uri: currentArtUri }} style={[styles.layer, labelCircleStyle]} />}
        {/* Cross-dissolves in directly on top of the current art as nextGain
            rises during a crossfade - no separate disc, no separate timing,
            just the real audio fade curve driving an opacity. */}
        {nextArtUri && <Image source={{ uri: nextArtUri }} style={[styles.layer, labelCircleStyle, { opacity: nextGain }]} />}
        <View style={[styles.layer, styles.labelRim, labelCircleStyle]} />
        <View style={[styles.layer, styles.hole, centeredCircleStyle(size, size * HOLE_FRACTION)]} />
      </SpinLayer>
      <Tonearm down={currentGain > 0 || nextGain > 0} progress={currentProgress} crossfading={crossfading} seeking={currentSeeking} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: 'center',
    marginVertical: 8,
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
});
