import { Image, StyleSheet, View } from 'react-native';

export interface CrossfadeArtProps {
  outgoingArtUri: string | null;
  incomingArtUri: string | null;
  /** [0,1] - see equalPowerGain; sample it at the current crossfade progress and pass the result straight through, so the art dissolves at exactly the rate the audio itself fades, not a separate approximation of it. */
  outgoingGain: number;
  incomingGain: number;
  size?: number;
}

const DEFAULT_SIZE = 96;

/**
 * Replaces the old bar-chart crossfade preview: the outgoing and incoming
 * tracks' cover art, cross-dissolved via opacity at the same equal-power
 * gain driving the actual audio crossfade (see App.tsx's outgoingGain/
 * incomingGain, sampled from the same equalPowerGain() call
 * SourceNode.rampGainCurve uses for real playback). A track with no art
 * gets a plain placeholder square at that same opacity, so the dissolve
 * timing still reads even when neither track has art.
 */
export function CrossfadeArt({ outgoingArtUri, incomingArtUri, outgoingGain, incomingGain, size = DEFAULT_SIZE }: CrossfadeArtProps): React.JSX.Element {
  const boxStyle = { width: size, height: size, borderRadius: size * 0.06 };
  return (
    <View style={[styles.container, boxStyle]}>
      {outgoingArtUri ? (
        <Image source={{ uri: outgoingArtUri }} style={[styles.layer, boxStyle, { opacity: outgoingGain }]} />
      ) : (
        <View style={[styles.layer, styles.placeholder, boxStyle, { opacity: outgoingGain }]} />
      )}
      {incomingArtUri ? (
        <Image source={{ uri: incomingArtUri }} style={[styles.layer, boxStyle, { opacity: incomingGain }]} />
      ) : (
        <View style={[styles.layer, styles.placeholder, boxStyle, { opacity: incomingGain }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    marginVertical: 8,
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  placeholder: {
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
});
