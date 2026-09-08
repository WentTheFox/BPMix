import { useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import type { Colors } from './theme';
import { darken, withAlpha } from './theme';

const TRACK_HEIGHT = 10;
const SCROLL_DURATION_MS = 1400;
/** Horizontal period of the (pre-skew) stripe pattern - one full scroll cycle shifts the layer by exactly this, so the loop wraps with no visible seam. */
const STRIPE_PERIOD = 20;
/** Exactly half the period, so light/dark stripes come out equal width - no lopsided gaps. */
const STRIPE_WIDTH = STRIPE_PERIOD / 2;
const SKEW_DEG = 45;

export interface LoadingBarProps {
  colors: Colors;
}

/**
 * Indeterminate loading progress bar - diagonal light/dark stripes rolling
 * sideways on a loop, "police line do not cross" tape style. Same
 * height/shape as SeekBar, so swapping between the two while a track loads
 * (see App.tsx) doesn't reflow anything around it - unlike a spinner-icon-
 * plus-text row, this never needs its own separate bit of reserved
 * vertical space.
 *
 * Built from plain vertical bars (each full TRACK_HEIGHT tall, so there's no
 * risk of a gap where a bar's rotated bounding box fails to reach the
 * track's top/bottom edge - the failure mode a per-bar `rotate` transform
 * has), sheared into diagonals with a single `skewX` on the whole tiled
 * layer - a shear only offsets x per row of y, it never shrinks a bar's
 * vertical coverage the way rotating a finite rectangle can. No gradient
 * library, no SVG - stays renderable on Windows the same as everywhere else,
 * unlike react-native-svg, which has no Windows build (see Icon.windows.tsx's
 * header comment for that constraint).
 *
 * Only the layer's translateX animates, via the native driver so it runs
 * independently of whatever's happening on the JS thread (metadata/art
 * fetches, React re-renders) - percentage-based `left` animation isn't
 * supported by the native driver, hence measuring the real pixel width via
 * onLayout instead. onLayout is guarded against re-firing for the same width
 * (RN can call it more than once as layout settles) - restarting the loop's
 * `Animated.loop` each time was the "stuttery" bug: a fresh loop resets to
 * frame zero, which reads as a visible stutter/jump if it happens more than
 * once.
 */
export function LoadingBar({ colors }: LoadingBarProps): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setTrackWidth((prev) => (Math.abs(prev - width) > 0.5 ? width : prev));
  };

  useEffect(() => {
    if (trackWidth <= 0) return;
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: SCROLL_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, trackWidth]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-STRIPE_PERIOD, 0] });
  // Margin on each side covers both the one-period scroll range and the
  // horizontal shift skewX introduces at the track's top/bottom edges
  // (TRACK_HEIGHT * tan(SKEW_DEG)), so no gap can appear at either end.
  const skewMargin = STRIPE_PERIOD + TRACK_HEIGHT * Math.tan((SKEW_DEG * Math.PI) / 180);
  const layerWidth = trackWidth > 0 ? trackWidth + 2 * skewMargin : 0;
  // One stripe per STRIPE_WIDTH (not STRIPE_PERIOD) - each period holds two
  // adjacent stripes (light then dark) that need to tile with no space
  // between them, not one stripe per period with an empty gap where the
  // second color of that period was supposed to go.
  const stripeCount = layerWidth > 0 ? Math.ceil(layerWidth / STRIPE_WIDTH) + 1 : 0;
  const lightColor = colors.accent;
  const darkColor = darken(colors.accent, 0.4);

  return (
    <View style={[styles.track, { backgroundColor: withAlpha(colors.accent, 0.18) }]} onLayout={handleLayout}>
      {trackWidth > 0 && (
        // skewX lives on this plain (non-animated) outer View, with only
        // translateX on the inner Animated.View - react-native-web's
        // Animated implementation doesn't reliably keep a static transform
        // function (skewX here) alongside an animated one in the same
        // transform array, which read as "loading bar renders unskewed on
        // web" despite native rendering it correctly.
        <View style={[styles.stripeLayer, { left: -skewMargin, width: layerWidth, transform: [{ skewX: `-${SKEW_DEG}deg` }] }]}>
          <Animated.View style={[styles.stripeInner, { transform: [{ translateX }] }]}>
            {Array.from({ length: stripeCount }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.stripe,
                  { left: i * STRIPE_WIDTH, backgroundColor: i % 2 === 0 ? lightColor : darkColor },
                ]}
              />
            ))}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TRACK_HEIGHT,
    marginTop: 12,
    borderRadius: 5,
    overflow: 'hidden',
  },
  stripeLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  stripeInner: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  stripe: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: STRIPE_WIDTH,
  },
});
