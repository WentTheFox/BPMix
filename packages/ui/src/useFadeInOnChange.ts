import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

/**
 * Returns an Animated.Value that resets to 0 and eases back to 1 every time
 * `key` changes - drives a fade-in for "the thing here just changed"
 * transitions (now-playing track info, an up-next preview, ...).
 *
 * Deliberately keyed on identity (e.g. a fileId) rather than on *why* it
 * changed: the same fade plays whether the track changed via a manual
 * skip, a natural end-of-track advance, or picking a different track in
 * the list outright - those differ in how the audio itself transitions,
 * but the display should transition the same way regardless.
 */
export function useFadeInOnChange(key: string | null | undefined, durationMs = 300): Animated.Value {
  const opacity = useRef(new Animated.Value(key == null ? 0 : 1)).current;
  const previousKeyRef = useRef(key);
  useEffect(() => {
    if (previousKeyRef.current === key) return;
    previousKeyRef.current = key;
    if (key == null) {
      opacity.setValue(0);
      return;
    }
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: durationMs, useNativeDriver: true }).start();
  }, [key, durationMs, opacity]);
  return opacity;
}
