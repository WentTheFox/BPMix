import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

/** Scroll speed - constant regardless of how far a given title overflows, so a barely-clipped title crawls past just as fast (in px/s) as a wildly long one, only the total scroll duration differs. Kept identical to MarqueeText.tsx's own constant - not shared from there since that file is the native/fallback platform-split sibling, not a module this one imports. */
const PIXELS_PER_SECOND = 40;
/** How long the text holds still at each end before reversing - see MarqueeText.tsx's identical constant. */
const EDGE_PAUSE_MS = 1200;

export interface MarqueeTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
}

/** @types/react-native's ViewStyle has no idea about react-native-web's animationKeyframes/animation* style extensions - same situation as useSpin.web.ts's WebSpinStyle. */
type WebMarqueeStyle = ViewStyle & {
  animationKeyframes: unknown;
  animationDuration: string;
  animationTimingFunction: string;
  animationIterationCount: string;
};

/**
 * One full hold-scroll-hold-scroll-back cycle expressed as percentage
 * keyframes within a single fixed-duration @keyframes rule, rather than
 * MarqueeText.tsx's Animated.sequence of delay/timing steps - a hold is
 * just two adjacent keyframe stops with the same translateX value, so a
 * single 'linear' timing function for the whole animation still holds
 * flat during those stretches (the interpolated value can't move when
 * both keyframe ends of that segment are identical).
 */
function webMarqueeStyle(scrollDistance: number, travelMs: number): WebMarqueeStyle {
  const totalMs = travelMs * 2 + EDGE_PAUSE_MS * 2;
  const holdEndPercent = (EDGE_PAUSE_MS / totalMs) * 100;
  const scrollOutEndPercent = ((EDGE_PAUSE_MS + travelMs) / totalMs) * 100;
  const holdAtEndEndPercent = ((EDGE_PAUSE_MS * 2 + travelMs) / totalMs) * 100;
  const keyframes = [
    {
      '0%': { transform: 'translateX(0px)' },
      [`${holdEndPercent}%`]: { transform: 'translateX(0px)' },
      [`${scrollOutEndPercent}%`]: { transform: `translateX(-${scrollDistance}px)` },
      [`${holdAtEndEndPercent}%`]: { transform: `translateX(-${scrollDistance}px)` },
      '100%': { transform: 'translateX(0px)' },
    },
  ];
  return {
    animationKeyframes: keyframes,
    animationDuration: `${totalMs}ms`,
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  } as WebMarqueeStyle;
}

/**
 * Web marquee - a plain CSS `animation` (react-native-web's
 * `animationKeyframes` style, which compiles down to a real @keyframes
 * rule) computed once whenever the text/overflow amount actually changes,
 * instead of MarqueeText.tsx's Animated.Value driven by
 * Animated.loop/Animated.timing. That version's useNativeDriver:true isn't
 * a real native driver on web (react-native-web has no separate UI thread
 * - its TimingAnimation always steps the value via requestAnimationFrame
 * regardless of the flag), so it was retargeting/recomputing the
 * translateX transform on every single animation frame from JS. This
 * version hands the whole hold-scroll-hold-scroll-back cycle to the
 * browser's compositor once per text/overflow change and touches no JS at
 * all while it plays. See useSpin.web.ts for the identical pattern already
 * established here for CrossfadeArt's disc spin.
 */
export function MarqueeText({ text, style }: MarqueeTextProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);

  const overflowing = containerWidth > 0 && textWidth > containerWidth;
  const scrollDistance = overflowing ? textWidth - containerWidth : 0;
  const travelMs = (scrollDistance / PIXELS_PER_SECOND) * 1000;

  // Recomputed (and thus a fresh animation-name/class, restarting the
  // animation from 0%) only when the text itself changes or the measured
  // overflow amount actually does - NOT on every unrelated re-render (e.g.
  // NowPlayingScreen's ~200ms playback-position poll tick), which would
  // otherwise call StyleSheet.create() fresh every time and keep
  // restarting the animation before it ever visibly progressed.
  const trackStyle = useMemo(() => {
    if (!overflowing) return styles.track;
    return [styles.track, StyleSheet.create({ marquee: webMarqueeStyle(scrollDistance, travelMs) }).marquee];
    // text is deliberately a dep despite not being read above - a new track
    // whose title happens to produce the exact same scrollDistance/travelMs
    // as the previous one (same overflow amount) should still restart the
    // animation from 0%, not silently keep whatever cycle position the old
    // title's animation was already mid-way through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overflowing, scrollDistance, travelMs, text]);

  return (
    <View style={styles.container} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      {/* See MarqueeText.tsx's identical measurer for why this has to be
          absolutely positioned, unconstrained, and forced nowrap. */}
      <Text style={[style, styles.measurer]} onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}>
        {text}
      </Text>
      {overflowing ? (
        <View style={trackStyle}>
          <Text style={style} numberOfLines={1}>
            {text}
          </Text>
        </View>
      ) : (
        <Text style={style} numberOfLines={1}>
          {text}
        </Text>
      )}
    </View>
  );
}

/** react-native-web accepts (and needs, see `measurer` below) a `whiteSpace` style value that isn't part of React Native's own TextStyle - same as MarqueeText.tsx's identical MeasurerStyle. */
type MeasurerStyle = TextStyle & { whiteSpace?: 'nowrap' };

const styles = StyleSheet.create({
  container: {
    width: '100%',
    overflow: 'hidden',
  },
  measurer: {
    position: 'absolute',
    top: 0,
    left: 0,
    opacity: 0,
    whiteSpace: 'nowrap',
  } as MeasurerStyle,
  // alignSelf:'flex-start' (rather than the container's default stretch)
  // is what lets this size to the text's own intrinsic width instead of
  // being squeezed to the container's - the container's overflow:hidden
  // then clips whatever extends past its edge as the animation slides it.
  track: {
    alignSelf: 'flex-start',
  },
});
