import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

/** Scroll speed - constant regardless of how far a given title overflows, so a barely-clipped title crawls past just as fast (in px/s) as a wildly long one, only the total scroll duration differs. */
const PIXELS_PER_SECOND = 40;
/** How long the text holds still at each end before reversing - long enough to read the start/end of a merely-slightly-clipped title before it moves again. */
const EDGE_PAUSE_MS = 1200;

export interface MarqueeTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
}

/**
 * A single line of text that scrolls back and forth (like a classic
 * marquee/ticker) instead of wrapping or truncating, but ONLY when it
 * actually doesn't fit its container on one line - text that already fits
 * renders as a perfectly ordinary static, centered Text with no animation
 * or measurement overhead. Used for the Now Playing screen's title/artist
 * line, which previously wrapped to 2 lines for a long track name/artist
 * combination.
 *
 * Measures its own natural (unwrapped) width via an invisible, absolutely
 * positioned copy of the text - a plain onLayout on the visible text would
 * report whatever width its (stretched-to-fill) parent already constrained
 * it to, not the width it actually needs to render on one line, which is
 * the one number this component actually needs to decide whether to
 * scroll at all.
 */
export function MarqueeText({ text, style }: MarqueeTextProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const translateX = useRef(new Animated.Value(0)).current;

  const overflowing = containerWidth > 0 && textWidth > containerWidth;
  const scrollDistance = overflowing ? textWidth - containerWidth : 0;

  useEffect(() => {
    translateX.setValue(0);
    if (!overflowing) return;
    const duration = (scrollDistance / PIXELS_PER_SECOND) * 1000;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(EDGE_PAUSE_MS),
        Animated.timing(translateX, { toValue: -scrollDistance, duration, easing: Easing.linear, useNativeDriver: true }),
        Animated.delay(EDGE_PAUSE_MS),
        Animated.timing(translateX, { toValue: 0, duration, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [overflowing, scrollDistance, translateX, text]);

  return (
    <View style={styles.container} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      {/* Invisible, out of layout flow (absolute + no width constraint) so
          its onLayout reports the text's true single-line width regardless
          of how narrow the real container is. Deliberately NOT
          numberOfLines={1} here (unlike every other Text in this file) -
          react-native-web implements numberOfLines by injecting its own
          max-width:100% (part of the ellipsis-truncation CSS), which for
          this absolutely-positioned element resolves against the nearest
          definite containing block - the outer `container` below - right
          back down to ITS width, silently capping the one measurement
          this whole component exists to take correctly. Confirmed live:
          with numberOfLines here, textWidth could never exceed
          containerWidth and the marquee never activated. A plain
          single-line Text with no width constraint sizes to its own
          content on both platforms without it. */}
      <Text style={[style, styles.measurer]} onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}>
        {text}
      </Text>
      {overflowing ? (
        <Animated.View style={[styles.track, { transform: [{ translateX }] }]}>
          <Text style={style} numberOfLines={1}>
            {text}
          </Text>
        </Animated.View>
      ) : (
        <Text style={style} numberOfLines={1}>
          {text}
        </Text>
      )}
    </View>
  );
}

/** react-native-web accepts (and needs, see `measurer` below) a `whiteSpace` style value that isn't part of React Native's own TextStyle - @types/react-native has no idea about it, same situation as useSpin.web.ts's animationKeyframes. */
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
    // Web-only (harmless no-op on native, which has no equivalent quirk):
    // react-native-web's Text base style sets white-space:pre-wrap, and
    // per the CSS shrink-to-fit algorithm, an absolutely positioned box
    // pinned only by `left` (no `right`/width) still has its available
    // width bounded by its containing block when wrapping is permitted -
    // confirmed live, the measurer was silently wrapping down to (and
    // reporting) the container's own width instead of its true unwrapped
    // width. Forcing nowrap makes the box's width exactly its unwrapped
    // content width regardless of container size, which is the one
    // number this component exists to measure correctly.
    whiteSpace: 'nowrap',
  } as MeasurerStyle,
  // alignSelf:'flex-start' (rather than the container's default stretch)
  // is what lets this size to the text's own intrinsic width instead of
  // being squeezed to the container's - the container's overflow:hidden
  // then clips whatever extends past its edge as translateX slides it.
  track: {
    alignSelf: 'flex-start',
  },
});
