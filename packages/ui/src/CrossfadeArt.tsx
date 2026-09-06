import { memo, useEffect, useId, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useSpin } from './spin/useSpin';

export interface CrossfadeArtProps {
  /** Identity (fileId) of whatever should be in the "current" slot right now. */
  currentTrackKey: string | null;
  currentArtUri: string | null;
  /** [0,1] - how audible the current track is right now (its actual crossfade gain). Drives only the tonearm's lift (down once genuinely audible) - disc rotation itself tracks currentProgress/currentTurnsPerSecond instead, not this. */
  currentGain: number;
  /** [0,1] - how far into the current track playback has reached. Anchors the disc's own rotation and drives the tonearm's needle position (outer edge at 0, disc center at 1) - NOT reset or hidden by pausing, so a paused tonearm stays parked over wherever it actually stopped instead of jumping back to the edge. Defaults to 0. */
  currentProgress?: number;
  /**
   * Real full turns per second the current disc should be continuously
   * spinning at right now (0 while paused) - e.g. TURNS_PER_SONG /
   * durationSeconds for ordinary playback, or a much higher value derived
   * from an in-flight rewindTo()/fastForwardTo() scrub. Drives the actual
   * spin animation (see useSpin) as a continuous native/CSS animation
   * rather than a per-tick retarget; currentProgress only anchors its
   * starting angle whenever this changes. Defaults to 0 (frozen).
   */
  currentTurnsPerSecond?: number;
  /** Identity (fileId) of whatever should be in the "next" slot right now. */
  nextTrackKey: string | null;
  nextArtUri: string | null;
  /** [0,1] - how audible the next track is right now. Drives only the tonearm's lift the same way currentGain does. */
  nextGain: number;
  /** Same as currentProgress, for the next slot's tonearm - 0 whenever the next track hasn't actually started playing yet (i.e. outside an in-progress crossfade), which is most of the time, so its needle stays parked at the outer edge until a crossfade actually brings it in. */
  nextProgress?: number;
  /** Same as currentTurnsPerSecond, for the next slot's disc - 0 outside an in-progress crossfade, same as nextProgress. */
  nextTurnsPerSecond?: number;
  size?: number;
}

const DEFAULT_SIZE = 84;
const GAP = 16;
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

interface VinylDiscProps {
  artUri: string | null;
  /** [0,1] through the track - anchors the spin's starting angle whenever turnsPerSecond changes; see useSpin's doc. */
  progress: number;
  /** Real turns/second the spin should be continuously running at right now (0 = frozen) - see CrossfadeArtProps.currentTurnsPerSecond's doc. */
  turnsPerSecond: number;
  /** Stable identity for this disc's spin across a mount/unmount (see useSpin.web.ts) - not used natively, but required regardless so every call site supplies one. */
  spinId: string;
  size: number;
  opacity?: Animated.Value | number;
  translateX?: Animated.Value | number;
}

/**
 * Memoized with a comparator that deliberately excludes `progress` - once
 * a rate is set, useSpin's continuous native/CSS animation runs entirely
 * off the JS thread and progress is only ever read again to re-anchor
 * *when turnsPerSecond changes*, never on its own. Without this, every
 * ~200ms position poll (which updates progress on every render regardless
 * of whether the rate actually changed) would still re-render this
 * component and re-run its effects for no visual benefit, competing with
 * the JS thread for no reason and risking exactly the stutter this
 * continuous-animation design exists to avoid.
 */
const VinylDisc = memo(function VinylDisc({ artUri, progress, turnsPerSecond, spinId, size, opacity = 1, translateX }: VinylDiscProps) {
  const spinStyle = useSpin(turnsPerSecond, progress, spinId);
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
  const grooveRadii = Array.from({ length: GROOVE_RING_COUNT }, (_, i) => size * grooveRingDiameterFraction(i));
  const labelCircleStyle = centeredCircleStyle(size, size * LABEL_FRACTION);
  return (
    <Animated.View style={[styles.layer, boxStyle, { opacity, transform: [{ translateX: translateX ?? 0 }] }]}>
      {/* Spin lives on its own inner layer, separate from the outer translateX/opacity - a web CSS `animation` on this View's transform can't be combined with a second, separately-driven transform on the same element (the animation fully owns `transform` while running), so translateX has to live one level up instead. */}
      <Animated.View style={[styles.layer, boxStyle, spinStyle]}>
        <View style={[styles.layer, styles.vinylBody, boxStyle]} />
        {grooveRadii.map((diameter, i) => (
          <View key={i} style={[styles.layer, styles.groove, centeredCircleStyle(size, diameter)]} />
        ))}
        <View style={[styles.layer, styles.labelBase, labelCircleStyle]} />
        {artUri && <Animated.Image source={{ uri: artUri }} style={[styles.layer, labelCircleStyle, { opacity: artOpacity }]} />}
        <View style={[styles.layer, styles.labelRim, labelCircleStyle]} />
        <View style={[styles.layer, styles.hole, centeredCircleStyle(size, size * HOLE_FRACTION)]} />
      </Animated.View>
    </Animated.View>
  );
},
// Deliberately omits `progress` - see VinylDisc's own doc for why.
(prev, next) =>
  prev.artUri === next.artUri &&
  prev.turnsPerSecond === next.turnsPerSecond &&
  prev.spinId === next.spinId &&
  prev.size === next.size &&
  prev.opacity === next.opacity &&
  prev.translateX === next.translateX,
);

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
  // Eased rather than linear - same start (outer rim) and end (label edge)
  // positions, but a real record's constant angular velocity means the
  // needle covers the same time span in a smaller, faster-shrinking arc as
  // it nears the center, so it visibly picks up speed moving inward
  // instead of crossing the disc at a constant rate.
  const easedProgress = Easing.in(Easing.cubic)(clampedProgress);
  const targetDeg = TONEARM_ANGLE_OUTER_DEG + (TONEARM_ANGLE_INNER_DEG - TONEARM_ANGLE_OUTER_DEG) * easedProgress;
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

interface DiscSnapshot {
  key: string;
  artUri: string | null;
  /** Captured once, at the moment this snapshot is taken - a fade-out/fade-in ghost only lives for CROSSFADE_ART_TRANSITION_MS, so freezing its rotation at whatever angle it had is imperceptible. */
  progress: number;
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
 * the art - shown side by side. Each disc's rotation is a pure function of
 * its own progress (see spinConstants.ts's TURNS_PER_SONG) rather than an
 * open-ended, audibility-driven animation - always exactly consistent with
 * playback position, and freezes for free on pause. Audibility (whether a
 * disc is actually contributing to what's audible right now) instead only
 * drives the tonearm's lift.
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
  currentTurnsPerSecond = 0,
  nextTrackKey,
  nextArtUri,
  nextGain,
  nextProgress = 0,
  nextTurnsPerSecond = 0,
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

  // Namespaces each slot's spinId (see VinylDisc/useSpin.web.ts) so multiple
  // CrossfadeArt instances on screen at once don't share spin continuity.
  const spinIdBase = useId();

  const slideX = useRef(new Animated.Value(0)).current;
  const outgoingOpacity = useRef(new Animated.Value(0)).current;
  const incomingOpacity = useRef(new Animated.Value(0)).current;
  const nextOpacity = useRef(new Animated.Value(nextTrackKey ? 1 : 0)).current;

  // Holds whatever currentProgress was on the PREVIOUS render - by the time
  // the current-slot-changing effect below runs, the closed-over
  // currentProgress prop already reflects the NEW track, so this is the
  // only way to freeze an outgoing ghost disc's rotation at the angle the
  // old track actually had rather than the new one's ~0.
  const previousProgressRef = useRef(currentProgress);
  const lastKnownProgress = previousProgressRef.current;
  previousProgressRef.current = currentProgress;

  // Always current - read by the watchdog below via a ref (not as an
  // effect dependency) so it can self-heal using whatever's actually true
  // *right now*, not a stale closure from whenever the stuck transition
  // started.
  const latestPropsRef = useRef({ currentTrackKey, currentArtUri, nextTrackKey, nextArtUri });
  latestPropsRef.current = { currentTrackKey, currentArtUri, nextTrackKey, nextArtUri };

  // Safety net: the normal finalize() path (below) is scheduled via a
  // plain setTimeout, which native platforms can silently delay or drop
  // entirely while the app is backgrounded (confirmed on Android) - with
  // nothing else watching for that, a transition interrupted that way
  // left transitioning/outgoing/incoming stuck forever: the real current
  // disc (gated on `!transitioning`) never rendered again, and whichever
  // ghost was last on screen stayed frozen there permanently instead.
  // Firing well past CROSSFADE_ART_TRANSITION_MS - long enough to never
  // preempt a transition that's actually still in progress - and snapping
  // straight to the live props (not replaying the original transition)
  // means this self-heals correctly regardless of how far things drifted
  // in the meantime.
  useEffect(() => {
    if (!transitioning) return;
    const watchdog = setTimeout(() => {
      const latest = latestPropsRef.current;
      slideX.setValue(0);
      outgoingOpacity.setValue(0);
      incomingOpacity.setValue(0);
      nextOpacity.setValue(latest.nextTrackKey ? 1 : 0);
      setTransitioning(false);
      setOutgoing(null);
      setIncoming(null);
      setDisplayed({
        currentKey: latest.currentTrackKey,
        currentArt: latest.currentArtUri,
        nextKey: latest.nextTrackKey,
        nextArt: latest.nextArtUri,
      });
    }, CROSSFADE_ART_TRANSITION_MS * 4);
    return () => clearTimeout(watchdog);
  }, [transitioning]);

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
    setOutgoing(displayed.currentKey ? { key: displayed.currentKey, artUri: displayed.currentArt, progress: lastKnownProgress } : null);
    outgoingOpacity.setValue(1);
    Animated.timing(outgoingOpacity, { toValue: 0, duration: CROSSFADE_ART_TRANSITION_MS, easing: Easing.linear, useNativeDriver: true }).start();

    // Always reset first, regardless of which branch below actually
    // animates it - if the previous transition was a natural progression
    // that got interrupted before its own timeout could fire (e.g. a
    // manual skip landing mid-slide), slideX would otherwise be left
    // stranded at -(size+GAP): the next slot's disc stuck rendered on top
    // of the current slot (behind its tonearm), and the next slot itself
    // left looking empty.
    slideX.setValue(0);

    if (isNaturalProgression) {
      setIncoming(null);
      // The sliding disc IS the next-slot disc (already rendered at the
      // right slot's fixed position) - translateX 0 is "still at the
      // right slot", so it animates to -(size+GAP) (one slot-width plus
      // the gap, leftward) to land exactly on the left slot.
      Animated.timing(slideX, {
        toValue: -(size + GAP),
        duration: CROSSFADE_ART_TRANSITION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      setIncoming({ key: currentTrackKey, artUri: currentArtUri, progress: currentProgress });
      incomingOpacity.setValue(0);
      Animated.timing(incomingOpacity, { toValue: 1, duration: CROSSFADE_ART_TRANSITION_MS, easing: Easing.linear, useNativeDriver: true }).start();
    }

    // Guarded so it only ever actually applies once - called normally when
    // the timeout fires, but ALSO from this effect's cleanup, so that a
    // transition interrupted by another track change before its own 450ms
    // is up still gets finalized immediately instead of leaving
    // transitioning/outgoing/incoming/slideX stuck mid-flight forever (the
    // next effect run's own setup would otherwise start from that stale
    // state instead of a clean one - previously the cause of a disc
    // getting stranded on top of the wrong slot, or the current slot's own
    // disc staying hidden behind ghost layers indefinitely).
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
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
    };
    const timeout = setTimeout(finalize, CROSSFADE_ART_TRANSITION_MS);
    return () => {
      clearTimeout(timeout);
      finalize();
    };
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

  const containerStyle = { width: size * 2 + GAP, height: size };
  const boxStyle = { width: size, height: size };

  return (
    <View style={[styles.row, containerStyle]}>
      <View style={[styles.slot, boxStyle, { left: 0 }]}>
        {!transitioning && (
          <VinylDisc
            artUri={displayed.currentArt}
            progress={currentProgress}
            turnsPerSecond={currentTurnsPerSecond}
            spinId={`${spinIdBase}-current`}
            size={size}
          />
        )}
        {outgoing && (
          <VinylDisc
            artUri={outgoing.artUri}
            progress={outgoing.progress}
            turnsPerSecond={currentTurnsPerSecond}
            spinId={`${spinIdBase}-outgoing`}
            size={size}
            opacity={outgoingOpacity}
          />
        )}
        {incoming && (
          <VinylDisc
            artUri={incoming.artUri}
            progress={incoming.progress}
            turnsPerSecond={currentTurnsPerSecond}
            spinId={`${spinIdBase}-incoming`}
            size={size}
            opacity={incomingOpacity}
          />
        )}
        {/* Forced up (`!transitioning &&`) for the swap/fade's whole duration, not just while a disc is actually mid-slide - the needle has to be clear before a disc starts moving under it, not just while it's moving. */}
        <Tonearm down={!transitioning && currentGain > 0} progress={currentProgress} size={size} />
      </View>
      <View style={[styles.slot, boxStyle, { left: size + GAP }]}>
        <VinylDisc
          artUri={displayed.nextArt}
          progress={nextProgress}
          turnsPerSecond={nextTurnsPerSecond}
          spinId={`${spinIdBase}-next`}
          size={size}
          opacity={nextOpacity}
          translateX={slideX}
        />
        <Tonearm down={!transitioning && nextGain > 0} progress={nextProgress} size={size} />
      </View>
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
});
