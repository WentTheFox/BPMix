import { useEffect, useRef, useState } from 'react';
import { NativeModules, StyleSheet, Text, View } from 'react-native';

const SAMPLE_INTERVAL_MS = 500;
const MAX_SAMPLES = 120; // 60s of history at the interval above
const SPARKLINE_HEIGHT = 36;

interface MemoryInfoNativeModule {
  getMemoryInfoKb(): Promise<{ rssKb: number; hwmKb: number }>;
}

const MemoryInfo = NativeModules.MemoryInfo as MemoryInfoNativeModule | undefined;

/**
 * Dev-only live RSS sparkline, backed by the native MemoryInfo module (reads
 * /proc/self/status directly - see its comment for why, vs. android.os.Debug
 * or dumpsys, both of which force a GC as a side effect of measuring, which
 * would mask the exact leak this was built to chase). Absolutely positioned
 * and pointerEvents="none" so it never intercepts touches from the UI below.
 */
export function MemoryOverlay(): React.JSX.Element | null {
  const [samples, setSamples] = useState<number[]>([]);
  const peakRef = useRef(0);

  useEffect(() => {
    if (!MemoryInfo) return;
    let cancelled = false;
    const interval = setInterval(() => {
      MemoryInfo!.getMemoryInfoKb()
        .then(({ rssKb }) => {
          if (cancelled || rssKb < 0) return;
          if (rssKb > peakRef.current) peakRef.current = rssKb;
          setSamples((prev) => {
            const next = [...prev, rssKb];
            return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
          });
        })
        .catch(() => {});
    }, SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!MemoryInfo || samples.length === 0) {
    return null;
  }

  const latestKb = samples[samples.length - 1] ?? 0;
  // Scaled against the all-time peak, not the current window's min/max, so
  // the baseline stays fixed at 0 and the bar heights reflect true
  // magnitude - a window-relative scale would make a flat 2GB plateau look
  // identical to a flat 200MB one.
  const peakKb = Math.max(peakRef.current, 1);

  return (
    <View style={styles.container} pointerEvents="none">
      <Text style={styles.label}>
        RSS {(latestKb / 1024).toFixed(0)} MB · peak {(peakRef.current / 1024).toFixed(0)} MB
      </Text>
      <View style={styles.sparkline}>
        {samples.map((valueKb, i) => {
          const heightFraction = valueKb / peakKb;
          return (
            <View
              key={i}
              style={[styles.bar, { height: Math.max(2, heightFraction * SPARKLINE_HEIGHT) }]}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 999,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  label: {
    color: '#fff',
    fontSize: 11,
    marginBottom: 2,
  },
  sparkline: {
    height: SPARKLINE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end',
    overflow: 'hidden',
  },
  bar: {
    width: 2,
    marginRight: 1,
    backgroundColor: '#3987e5',
  },
});
