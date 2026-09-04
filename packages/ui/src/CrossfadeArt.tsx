import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet, View } from 'react-native';

export interface CrossfadeArtProps {
  /** Identity (fileId) of whatever's in the "current" slot right now - used only to detect a swap and trigger the one-shot fade-out below, not for display. */
  currentTrackKey: string | null;
  currentArtUri: string | null;
  /** [0,1] - how audible the current track is right now (its actual crossfade gain). Drives spin *speed*, not opacity - full speed near 1, slowing toward a near-stop as it fades out during an actual crossfade. */
  currentGain: number;
  nextArtUri: string | null;
  /** [0,1] - how audible the next track is right now. Drives spin speed the same way, ramping up from a slow idle turn as an actual crossfade into it progresses. */
  nextGain: number;
  size?: number;
}

const DEFAULT_SIZE = 84;
/** Duration of one full turn at gain=1 (normal speed). */
const BASE_SPIN_MS = 16000;
/** A disc never fully stops turning - even at gain≈0 it keeps a bare, slow rotation, so "next up" reads as queued rather than broken/frozen. */
const MIN_SPIN_RATE = 0.12;
const OUTGOING_FADE_OUT_MS = 500;
const LABEL_FRACTION = 0.38;
const HOLE_FRACTION = 0.09;
const GROOVE_RING_COUNT = 3;
/** Spin rate is rounded to this granularity before restarting the loop animation - restarting on every ~200ms poll tick's tiny gain fluctuation would look jittery; only a genuinely audible speed change (mostly during an actual crossfade) should visibly re-time it. */
const RATE_BUCKET = 0.2;

function useSpin(rate: number): Animated.AnimatedInterpolation<string> {
  const rotation = useRef(new Animated.Value(0)).current;
  // rate<=0 means "not audible at all" (nothing playing) - genuinely stop
  // turning rather than applying the MIN_SPIN_RATE floor, which is only
  // meant to keep an audible-but-quiet disc from looking frozen/broken.
  const bucketedRate = rate <= 0 ? 0 : Math.max(MIN_SPIN_RATE, Math.round(rate / RATE_BUCKET) * RATE_BUCKET);
  useEffect(() => {
    if (bucketedRate <= 0) {
      // Freezes wherever the loop's own cleanup below already left it
      // (Animated.loop's stop() halts in place, not a reset to 0deg) -
      // reads as the record actually coming to a stop.
      return;
    }
    rotation.setValue(0);
    const loop = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: BASE_SPIN_MS / bucketedRate,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [bucketedRate, rotation]);
  return rotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
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
}: {
  artUri: string | null;
  rate: number;
  size: number;
  opacity?: Animated.Value | number;
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
    <Animated.View style={[boxStyle, { opacity, transform: [{ rotate: spin }] }]}>
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
 * Plays a single fade-out (not a continuous gain-tied dissolve) for
 * whatever was showing in the "current" slot right before it got replaced -
 * captures the outgoing disc's art the moment currentTrackKey changes,
 * animates its opacity from 1 to 0 once, then drops it. The new current
 * disc is already fully visible underneath throughout (no fade-in of its
 * own), so this reads as the old cover dissolving away to reveal the new
 * one already in place, rather than a discontinuous swap.
 */
function useOutgoingFadeOut(
  currentTrackKey: string | null,
  currentArtUri: string | null,
): { outgoing: { key: string; artUri: string | null } | null; opacity: Animated.Value } {
  const [outgoing, setOutgoing] = useState<{ key: string; artUri: string | null } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const prevKeyRef = useRef(currentTrackKey);
  const prevArtRef = useRef(currentArtUri);
  useEffect(() => {
    const prevKey = prevKeyRef.current;
    const prevArt = prevArtRef.current;
    if (prevKey && currentTrackKey && prevKey !== currentTrackKey) {
      setOutgoing({ key: prevKey, artUri: prevArt });
      opacity.setValue(1);
      Animated.timing(opacity, {
        toValue: 0,
        duration: OUTGOING_FADE_OUT_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setOutgoing(null);
      });
    }
    prevKeyRef.current = currentTrackKey;
    prevArtRef.current = currentArtUri;
  }, [currentTrackKey, currentArtUri, opacity]);
  return { outgoing, opacity };
}

/**
 * The current and next tracks' cover art, each circle-cropped like a
 * record - center label, spindle hole, and a few faint groove rings over
 * the art - shown side by side, always at full opacity once known (the
 * next disc appears the instant its art/metadata resolves, never waiting
 * on the crossfade itself). Audibility is conveyed by spin *speed* instead
 * of opacity: the current disc spins at normal speed and slows as an
 * actual crossfade fades it out, the next disc idles at a slow turn and
 * speeds up as a crossfade brings it in - both driven by the same
 * equal-power gain curve powering the real audio fade (see App.tsx's
 * outgoingGain/incomingGain, sampled from the same equalPowerGain() call
 * SourceNode.rampGainCurve uses for real playback). The one moment this
 * doesn't track gain continuously is the instant a track stops being
 * current: that disc plays a single fixed-duration fade-out (see
 * useOutgoingFadeOut) rather than a discontinuous pop.
 */
export function CrossfadeArt({ currentTrackKey, currentArtUri, currentGain, nextArtUri, nextGain, size = DEFAULT_SIZE }: CrossfadeArtProps): React.JSX.Element {
  const { outgoing, opacity: outgoingFadeOpacity } = useOutgoingFadeOut(currentTrackKey, currentArtUri);
  const boxStyle = { width: size, height: size };
  return (
    <View style={styles.row}>
      <View style={boxStyle}>
        <VinylDisc artUri={currentArtUri} rate={currentGain} size={size} />
        {outgoing && (
          <View style={[styles.layer, boxStyle]}>
            <VinylDisc artUri={outgoing.artUri} rate={1} size={size} opacity={outgoingFadeOpacity} />
          </View>
        )}
      </View>
      <VinylDisc artUri={nextArtUri} rate={nextGain} size={size} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    marginVertical: 8,
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
});
