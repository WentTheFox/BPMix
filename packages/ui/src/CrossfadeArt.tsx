import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

export interface CrossfadeArtProps {
  /** Identity (fileId) of whatever should be in the "current" slot right now. */
  currentTrackKey: string | null;
  currentArtUri: string | null;
  /** [0,1] - how audible the current track is right now (its actual crossfade gain). Drives spin *speed*, not opacity - full speed near 1, slowing toward a near-stop as it fades out during an actual crossfade. */
  currentGain: number;
  /** The current track's own loudness-normalization multiplier (@bpmix/core's computeNormalizationGain - 0.25-4, 1 = no adjustment needed). Drives the VU meter's *resting* level while audible - a quiet track sitting near the top of its meter (it's being boosted), a loud one sitting near the bottom (it's being pulled down) - as distinct from currentGain's crossfade envelope, which only accounts for fade progress. Defaults to 1 (meter rests at its center) if not yet known. */
  currentNormalizedGain?: number;
  /** Identity (fileId) of whatever should be in the "next" slot right now. */
  nextTrackKey: string | null;
  nextArtUri: string | null;
  /** [0,1] - how audible the next track is right now. Drives spin speed the same way, ramping up from a slow idle turn as an actual crossfade into it progresses. */
  nextGain: number;
  /** Same as currentNormalizedGain, for the next slot's meter. */
  nextNormalizedGain?: number;
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
/** How long the needle takes to lift off/drop onto a disc when that slot's audibility crosses the audible/silent boundary. */
const TONEARM_MOVE_MS = 220;
/** Rotation (pivoting at its own top-right corner, arm body extending left from there) with the needle down, swung onto the disc. */
const TONEARM_DOWN_DEG = -46;
/** Rotation with the needle lifted clear of the disc - still angled toward it (reads as "parked over this slot, paused") rather than swung all the way back to resting flat. Small - there's very little clearance between the disc's top edge and the title/"up next" text sitting just above it, so the lifted position can't rise far before it'd overlap that text. */
const TONEARM_UP_DEG = 3;
const TONEARM_ARM_LENGTH_FRACTION = 0.34;
/**
 * VU meter flanking each disc: a fixed green/yellow/red scale (a real
 * meter's markings don't move) with a knob that slides along it to the
 * track's current level - NOT pinned near the top just because a track is
 * playing at full crossfade audibility. The knob's resting position (while
 * audible) reflects the track's own normalizationGain relative to 1
 * (unity - no adjustment needed): a quiet track that's being boosted sits
 * higher, a loud one being pulled down sits lower. It still drops to the
 * bottom on pause or as an actual crossfade fades the slot out - that part
 * *is* currentGain/nextGain, same as the disc spin.
 */
const VU_METER_WIDTH = 10;
const VU_METER_GAP = 8;
/** gainDb range mapped onto the meter's full height - computeNormalizationGain clamps to ±12dB, so this covers its whole possible range; unity gain (0dB, no adjustment) lands at the vertical center. */
const VU_GAIN_DB_RANGE = 12;
const VU_KNOB_HEIGHT = 4;
/** Spring constants for the knob's motion - tuned to overshoot a little rather than move plainly like everything else driven straight off gain (the disc spin, the crossfade curve itself), since a VU meter's whole character is that physical bounce. */
const VU_SPRING_CONFIG = { friction: 5, tension: 80 };

/** Maps a normalizationGain multiplier (0.25-4, 1 = unity) to [0,1] - unity at the center, clamped at the meter's ±VU_GAIN_DB_RANGE edges. */
function normalizedGainToLevel(normalizedGain: number): number {
  const gainDb = 20 * Math.log10(Math.max(1e-6, normalizedGain));
  return Math.max(0, Math.min(1, (gainDb + VU_GAIN_DB_RANGE) / (VU_GAIN_DB_RANGE * 2)));
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
  // an actual radial texture.
  const grooveRadii = Array.from({ length: GROOVE_RING_COUNT }, (_, i) => {
    const t = (i + 1) / (GROOVE_RING_COUNT + 1);
    return size * LABEL_FRACTION + (size - size * LABEL_FRACTION) * t;
  });
  return (
    <Animated.View style={[styles.layer, boxStyle, { opacity, transform: [{ translateX: translateX ?? 0 }, { rotate: spin }] }]}>
      <View style={[styles.layer, styles.placeholder, boxStyle]} />
      {artUri && <Animated.Image source={{ uri: artUri }} style={[styles.layer, boxStyle, { opacity: artOpacity }]} />}
      {grooveRadii.map((diameter, i) => (
        <View key={i} style={[styles.layer, styles.groove, centeredCircleStyle(size, diameter)]} />
      ))}
      <View style={[styles.layer, styles.label, centeredCircleStyle(size, size * LABEL_FRACTION)]} />
      <View style={[styles.layer, styles.hole, centeredCircleStyle(size, size * HOLE_FRACTION)]} />
    </Animated.View>
  );
}

/**
 * The needle/tonearm resting over a slot - one per slot (current, next),
 * NOT one per VinylDisc instance, so it doesn't spin with the record and
 * doesn't multiply into several arms while outgoing/incoming ghost discs
 * are mounted mid-transition. Pivots at its own top-right corner, flush
 * with the disc's edge - there's very little vertical clearance above the
 * disc (the title/"up next" text sits right there), so the mount can't
 * float above it the way a real tonearm's base would - and swings down
 * onto the disc when `down` is true, lifting clear (but staying angled
 * toward the slot, like a parked player rather than one swung fully away)
 * when false.
 */
function Tonearm({ down, size }: { down: boolean; size: number }) {
  const lift = useRef(new Animated.Value(down ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(lift, { toValue: down ? 0 : 1, duration: TONEARM_MOVE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [down, lift]);
  // Positive rotate() here swings the (left-extending, right-anchored) arm
  // UP, not down - counterintuitive but confirmed on-device - hence
  // TONEARM_DOWN_DEG being the negative one of the pair.
  const rotate = lift.interpolate({ inputRange: [0, 1], outputRange: [`${TONEARM_DOWN_DEG}deg`, `${TONEARM_UP_DEG}deg`] });
  const armLength = size * TONEARM_ARM_LENGTH_FRACTION;
  return (
    <View style={styles.tonearmMount} pointerEvents="none">
      <View style={styles.tonearmPivot} />
      <Animated.View style={[styles.tonearmArm, { width: armLength, transform: [{ rotate }] }]}>
        <View style={styles.tonearmNeedle} />
      </Animated.View>
    </View>
  );
}

/**
 * `gain` is the crossfade audibility fraction (currentGain/nextGain - 0
 * when paused/faded out, ~1 while fully audible), `normalizedGain` is the
 * track's own loudness multiplier. The displayed level is the latter
 * (mapped to [0,1], unity centered) scaled by the former, so pausing or an
 * actual crossfade still pulls the knob down to the bottom, but a fully
 * audible track's resting height reflects its own normalization instead of
 * always sitting at the top.
 */
function VuMeter({ gain, normalizedGain, size, side }: { gain: number; normalizedGain: number; size: number; side: 'left' | 'right' }) {
  const targetLevel = normalizedGainToLevel(normalizedGain) * Math.max(0, Math.min(1, gain));
  const level = useRef(new Animated.Value(targetLevel)).current;
  useEffect(() => {
    Animated.spring(level, { toValue: targetLevel, useNativeDriver: true, ...VU_SPRING_CONFIG }).start();
    // Only the computed target should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLevel, level]);
  // level=0 knob center sits at the very bottom, level=1 at the very top.
  const translateY = level.interpolate({ inputRange: [0, 1], outputRange: [size - VU_KNOB_HEIGHT / 2, -VU_KNOB_HEIGHT / 2] });
  return (
    <View style={[styles.vuMeter, { width: VU_METER_WIDTH, height: size }, side === 'left' ? { left: 0 } : { right: 0 }]} pointerEvents="none">
      <View style={[styles.vuTrackBand, styles.vuTrackBandRed, { height: size * 0.15 }]} />
      <View style={[styles.vuTrackBand, styles.vuTrackBandYellow, { height: size * 0.15, top: size * 0.15 }]} />
      <View style={[styles.vuTrackBand, styles.vuTrackBandGreen, { height: size * 0.7, top: size * 0.3 }]} />
      <Animated.View style={[styles.vuKnob, { height: VU_KNOB_HEIGHT, transform: [{ translateY }] }]} />
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
 * values also drive a small VU meter flanking each disc (see VuMeter) -
 * used there as a multiplier on the track's own normalizationGain rather
 * than a spin rate, so pausing/fading still pulls the knob down the same
 * way the spin slows down.
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
  currentNormalizedGain = 1,
  nextTrackKey,
  nextArtUri,
  nextGain,
  nextNormalizedGain = 1,
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
      <VuMeter gain={currentGain} normalizedGain={currentNormalizedGain} size={size} side="left" />
      <View style={[styles.slot, boxStyle, { left: discsOffset }]}>
        {!transitioning && <VinylDisc artUri={displayed.currentArt} rate={currentGain} size={size} />}
        {outgoing && <VinylDisc artUri={outgoing.artUri} rate={1} size={size} opacity={outgoingOpacity} />}
        {incoming && <VinylDisc artUri={incoming.artUri} rate={currentGain} size={size} opacity={incomingOpacity} />}
        <Tonearm down={currentGain > 0} size={size} />
      </View>
      <View style={[styles.slot, boxStyle, { left: discsOffset + size + GAP }]}>
        <VinylDisc artUri={displayed.nextArt} rate={nextGain} size={size} opacity={nextOpacity} translateX={slideX} />
        <Tonearm down={nextGain > 0} size={size} />
      </View>
      <VuMeter gain={nextGain} normalizedGain={nextNormalizedGain} size={size} side="right" />
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
  placeholder: {
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  groove: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.15)',
  },
  label: {
    backgroundColor: 'rgba(0,0,0,0.35)',
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
  },
  vuTrackBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderRadius: 1.5,
    opacity: 0.3,
  },
  vuTrackBandRed: {
    backgroundColor: '#ef4444',
  },
  vuTrackBandYellow: {
    backgroundColor: '#f59e0b',
  },
  vuTrackBandGreen: {
    backgroundColor: '#22c55e',
  },
  vuKnob: {
    position: 'absolute',
    left: -2,
    right: -2,
    borderRadius: 2,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.4)',
  },
});
