import type { CrossfadeVisualization } from '@bpmix/core';
import { StyleSheet, Text, View } from 'react-native';

const CURVE_HEIGHT = 40;
const BAR_COUNT = 80;

interface Props {
  outgoingName: string;
  incomingName: string;
  visualization: CrossfadeVisualization;
  /**
   * Current playback position, in the same timeline coordinates as
   * visualization (seconds relative to the transition start at t=0) -
   * draws a live red line tracking actual playback. Omit/null while
   * that's not meaningful (e.g. nothing playing yet).
   */
  progressSeconds?: number | null;
}

/**
 * Debug view for Stage 7: draws the actual computed crossfade plan for
 * "current track -> next track in queue" - the same TransitionPlan/
 * CrossfadeVisualization data real playback scheduling uses, not a
 * separate illustration of it. Two lanes (outgoing on top, incoming
 * below) share one time axis spanning from a few seconds of normal
 * playback *before* the transition to a few seconds *after* it, with two
 * phases shaded on the outgoing lane: a dashed "ramp" window (rate
 * converging toward the incoming tempo, nothing from the incoming track
 * audible yet) followed by the plain-shaded "fade" window (the actual
 * audible crossfade, both tracks already tempo+phase matched by then).
 * The ramp window has zero width when no ramp is needed (tempos already
 * matched, or the incoming track is the one catching up instead). The
 * muted bars are the gain envelope (finely sampled for a smooth curve);
 * bright beat markers are drawn *on top* of them at each beat's exact
 * position (taller than the lane itself, so they read as a grid rather
 * than blending into the bars).
 */
export function CrossfadePreview({
  outgoingName,
  incomingName,
  visualization,
  progressSeconds,
}: Props): React.JSX.Element {
  const { timelineStartSeconds, timelineEndSeconds, rampStartSeconds, rampEndSeconds, fadeDurationSeconds, outgoing, incoming } =
    visualization;
  const span = timelineEndSeconds - timelineStartSeconds;
  const progressPercent =
    span > 0 && progressSeconds != null ? ((progressSeconds - timelineStartSeconds) / span) * 100 : null;
  const showProgress = progressPercent != null && progressPercent >= 0 && progressPercent <= 100;
  const hasRamp = rampEndSeconds - rampStartSeconds > 1e-6;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        Crossfade preview - {hasRamp ? `${(rampEndSeconds - rampStartSeconds).toFixed(0)}s ramp + ` : ''}
        {fadeDurationSeconds.toFixed(0)}s fade
      </Text>
      <View style={styles.plotArea}>
        <Lane
          label={outgoingName}
          bpm={outgoing.bpm}
          gainCurve={outgoing.gainCurve}
          beatTimesSeconds={outgoing.beatTimesSeconds}
          timelineStartSeconds={timelineStartSeconds}
          timelineEndSeconds={timelineEndSeconds}
          fadeDurationSeconds={fadeDurationSeconds}
          rampStartSeconds={rampStartSeconds}
          rampEndSeconds={rampEndSeconds}
          color="#e58a39"
        />
        <Lane
          label={incomingName}
          bpm={incoming.bpm}
          gainCurve={incoming.gainCurve}
          beatTimesSeconds={incoming.beatTimesSeconds}
          timelineStartSeconds={timelineStartSeconds}
          timelineEndSeconds={timelineEndSeconds}
          fadeDurationSeconds={fadeDurationSeconds}
          rampStartSeconds={0}
          rampEndSeconds={0}
          color="#3987e5"
        />
        {showProgress && <View style={[styles.progressLine, { left: `${progressPercent}%` }]} />}
      </View>
    </View>
  );
}

function Lane({
  label,
  bpm,
  gainCurve,
  beatTimesSeconds,
  timelineStartSeconds,
  timelineEndSeconds,
  fadeDurationSeconds,
  rampStartSeconds,
  rampEndSeconds,
  color,
}: {
  label: string;
  bpm: number;
  gainCurve: number[];
  beatTimesSeconds: number[];
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  fadeDurationSeconds: number;
  rampStartSeconds: number;
  rampEndSeconds: number;
  color: string;
}): React.JSX.Element {
  const span = timelineEndSeconds - timelineStartSeconds;
  const hasRamp = rampEndSeconds - rampStartSeconds > 1e-6;

  // Downsample the gain curve to BAR_COUNT bars regardless of how many
  // samples computeCrossfadeVisualization produced, so the bar width stays
  // consistent no matter the sample count passed in. This is the smooth
  // envelope shape only - beat timing is a separate, higher-contrast layer
  // drawn on top (see beatTick/alignmentTick below), not encoded in bars.
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const sourceIndex = Math.min(gainCurve.length - 1, Math.round((i / (BAR_COUNT - 1)) * (gainCurve.length - 1)));
    bars.push(gainCurve[sourceIndex] ?? 0);
  }

  const percentOf = (seconds: number): number => (span > 0 ? ((seconds - timelineStartSeconds) / span) * 100 : 0);
  const fadeStartPercent = percentOf(0);
  const fadeEndPercent = percentOf(fadeDurationSeconds);
  const rampStartPercent = percentOf(rampStartSeconds);
  const rampEndPercent = percentOf(rampEndSeconds);

  return (
    <View style={styles.lane}>
      <Text style={styles.laneLabel} numberOfLines={1}>
        {label} · {bpm > 0 ? `${bpm.toFixed(0)} BPM` : 'BPM unknown'} · {hasRamp ? 'ramp, then fade' : 'fade only'}
      </Text>
      <View style={styles.curveArea}>
        {hasRamp && (
          <View
            style={[
              styles.rampWindow,
              { left: `${rampStartPercent}%`, width: `${Math.max(0, rampEndPercent - rampStartPercent)}%` },
            ]}
          />
        )}
        <View
          style={[
            styles.fadeWindow,
            { left: `${fadeStartPercent}%`, width: `${Math.max(0, fadeEndPercent - fadeStartPercent)}%` },
          ]}
        />
        <View style={styles.bars}>
          {bars.map((gain, i) => (
            <View
              key={i}
              style={[styles.bar, { height: Math.max(1, gain * CURVE_HEIGHT), backgroundColor: color, opacity: 0.45 }]}
            />
          ))}
        </View>
        {span > 0 &&
          beatTimesSeconds.map((t, i) => {
            // The alignment point itself (t=0, the picked beat both tracks
            // start the transition on) gets an even brighter, wider mark
            // than the rest of the beat grid, so it reads as "this exact
            // beat was chosen" rather than just another tick in the
            // sequence. Both extend a few px past the lane's own height so
            // they read as a beat grid overlaying the curve, not another
            // part of it.
            const isAlignmentPoint = Math.abs(t) < 1e-6;
            return (
              <View
                key={i}
                style={[
                  isAlignmentPoint ? styles.alignmentTick : styles.beatTick,
                  { left: `${((t - timelineStartSeconds) / span) * 100}%` },
                ]}
              />
            );
          })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 8,
    padding: 8,
    marginTop: 8,
  },
  title: {
    color: '#ccc',
    fontSize: 11,
    marginBottom: 6,
  },
  plotArea: {
    position: 'relative',
    paddingVertical: 5,
  },
  lane: {
    marginBottom: 10,
  },
  laneLabel: {
    color: '#999',
    fontSize: 11,
    marginBottom: 2,
  },
  curveArea: {
    height: CURVE_HEIGHT,
    position: 'relative',
  },
  fadeWindow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  rampWindow: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.5)',
  },
  bars: {
    height: CURVE_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  bar: {
    flex: 1,
    marginRight: 1,
  },
  beatTick: {
    position: 'absolute',
    top: -5,
    bottom: -5,
    width: 2,
    backgroundColor: '#ffe066',
  },
  alignmentTick: {
    position: 'absolute',
    top: -5,
    bottom: -5,
    width: 3,
    backgroundColor: '#ffffff',
  },
  progressLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#ff3b3b',
  },
});
