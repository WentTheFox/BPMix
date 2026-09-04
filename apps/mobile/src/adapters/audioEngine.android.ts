import { bandsFromByteFrequencyData, type AudioEngine, type DecodedAudio, type FileAccess, type FileRef, type RampSpec, type SourceNode } from '@bpmix/core';
import { AudioContext, type AudioBuffer, type AudioBufferSourceNode } from 'react-native-audio-api';

function decodedAudioToBuffer(context: AudioContext, decoded: DecodedAudio): AudioBuffer {
  const frameCount = decoded.channelData[0]?.length ?? 0;
  const buffer = context.createBuffer(decoded.numberOfChannels, frameCount, decoded.sampleRate);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    buffer.copyToChannel(decoded.channelData[channel] as Float32Array<ArrayBuffer>, channel);
  }
  return buffer;
}

function audioBufferToDecoded(buffer: AudioBuffer): DecodedAudio {
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channelData.push(buffer.getChannelData(channel));
  }
  return {
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    channelData,
    durationSeconds: buffer.duration,
  };
}

/**
 * Maps each SourceNode we hand out to the closure that actually starts its
 * underlying AudioBufferSourceNode - see the identical note in the web
 * adapter, this mirrors it for the same reason.
 */
const startFns = new WeakMap<SourceNode, (whenSeconds: number, offsetSeconds: number) => void>();

/**
 * Native AudioBuffers are cached per decoded track (keyed by the DecodedAudio
 * object TrackPlayer holds onto for the track's whole loaded lifetime), not
 * rebuilt on every createSource() call. The library's own docs say buffers
 * are meant to be built once and reused across many cheap source nodes -
 * rebuilding one (a full PCM copy, tens of MB for a multi-minute track) on
 * every seek/pause/resume was both slow and, under rapid repeated seeking,
 * crashed the app with a native SIGSEGV from the allocation churn.
 */
const nativeBufferCache = new WeakMap<DecodedAudio, AudioBuffer>();

function getOrCreateBuffer(context: AudioContext, decoded: DecodedAudio): AudioBuffer {
  let buffer = nativeBufferCache.get(decoded);
  if (!buffer) {
    buffer = decodedAudioToBuffer(context, decoded);
    nativeBufferCache.set(decoded, buffer);
  }
  return buffer;
}

export function createAudioEngine(fileAccess: FileAccess): AudioEngine {
  const context = new AudioContext();
  let nextId = 0;

  return {
    async decodeFile(ref: FileRef): Promise<DecodedAudio> {
      const bytes = await fileAccess.readFileBytes(ref);
      const buffer = await context.decodeAudioData(bytes);
      return audioBufferToDecoded(buffer);
    },

    prepareBuffer(audio: DecodedAudio): void {
      // getOrCreateBuffer already caches per-DecodedAudio (see its own
      // doc) - calling it here just does that caching's real work (the
      // synchronous per-channel copyToChannel, a real on-device stall for
      // a multi-minute track) now instead of leaving it for whenever
      // createSource() first needs this audio, which on Android specifically
      // is right at a track-switch/crossfade moment.
      getOrCreateBuffer(context, audio);
    },

    createSource(audio: DecodedAudio, onEnded?: () => void): SourceNode {
      const buffer = getOrCreateBuffer(context, audio);
      // pitchCorrection: true engages react-native-audio-api's native WSOLA
      // time-stretcher (common/cpp/audioapi/dsp/WsolaTimeStretcher) instead
      // of plain resampling, so the outgoing track's rate ramp (Stage 7's
      // crossfade) changes tempo without also shifting pitch - matches
      // real DJ-style beatmatching instead of the "chipmunk/slowdown"
      // artifact a naive playbackRate change produces.
      const bufferSource: AudioBufferSourceNode = context.createBufferSource({ pitchCorrection: true });
      bufferSource.buffer = buffer;
      // Tapped BEFORE gainNode - see SourceNode.getFrequencyBands' doc,
      // this needs to read the music's own dynamics, not whatever fade/
      // volume gain is currently applied. A pass-through node (nothing
      // else connects to it), so its presence doesn't change what's
      // actually heard.
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      // Default 0.8 is a heavy exponential moving average baked into the
      // native node itself, on top of which the UI's own spring animation
      // adds further smoothing - the combination read as barely moving at
      // all (confirmed on-device). We already want the *display* to be
      // smooth (that's what the spring is for) - the underlying data
      // should be raw/reactive instead of pre-damped twice over.
      analyser.smoothingTimeConstant = 0;
      // Default range (-100 to -30 dBFS) leaves normally-mastered music
      // sitting right at/above maxDecibels almost the whole time - the
      // per-band values all clip near 255 and barely move (confirmed
      // on-device). Raising maxDecibels means it takes louder content to
      // reach the top of the byte range, giving typical program material
      // real headroom to show its actual variation instead of pinning.
      analyser.minDecibels = -80;
      analyser.maxDecibels = -10;
      const frequencyBuffer = new Uint8Array(analyser.frequencyBinCount);
      const gainNode = context.createGain();
      bufferSource.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(context.destination);

      // A Web-Audio-style graph keeps every connected node alive (a native,
      // non-JS-GC-tracked reference held by the graph itself) until it's
      // explicitly disconnected - browsers release finished one-shot source
      // nodes automatically, but this native reimplementation doesn't. Every
      // seek/pause/track-switch creates a fresh source+gain pair (even when
      // getOrCreateBuffer reuses the same underlying buffer, e.g. repeated
      // seeking within one track), so without this every one of those piles
      // up a permanently-retained node pair - the real cause of the Hermes
      // "external memory" OOM crash under rapid seeking this fixes.
      const disconnectNodes = () => {
        try {
          bufferSource.disconnect();
        } catch {
          // Already disconnected - fine.
        }
        try {
          analyser.disconnect();
        } catch {
          // Already disconnected - fine.
        }
        try {
          gainNode.disconnect();
        } catch {
          // Already disconnected - fine.
        }
      };

      if (onEnded) {
        bufferSource.onEnded = () => {
          onEnded();
          disconnectNodes();
        };
      }

      const node: SourceNode = {
        id: `android-source-${nextId++}`,
        setGain(value) {
          gainNode.gain.value = value;
        },
        rampGain(ramp: RampSpec) {
          const endTime = ramp.atTimeSeconds + ramp.durationSeconds;
          gainNode.gain.setValueAtTime(gainNode.gain.value, ramp.atTimeSeconds);
          gainNode.gain.linearRampToValueAtTime(ramp.toValue, endTime);
        },
        rampGainCurve(values, atTimeSeconds, durationSeconds) {
          gainNode.gain.setValueCurveAtTime(new Float32Array(values), atTimeSeconds, durationSeconds);
        },
        setRate(value) {
          bufferSource.playbackRate.value = value;
        },
        rampRate(ramp: RampSpec) {
          const endTime = ramp.atTimeSeconds + ramp.durationSeconds;
          bufferSource.playbackRate.setValueAtTime(bufferSource.playbackRate.value, ramp.atTimeSeconds);
          bufferSource.playbackRate.linearRampToValueAtTime(ramp.toValue, endTime);
        },
        stop(whenSeconds) {
          const effectiveWhen = whenSeconds ?? context.currentTime;
          try {
            bufferSource.stop(effectiveWhen);
          } catch {
            // Already stopped/never started - fine, this is a best-effort stop.
          }
          // disconnect() silences output immediately, regardless of
          // whenSeconds - correct for an immediate stop (pause/seek/track
          // switch, the vast majority of calls), but a *scheduled future*
          // stop (Stage 7's crossfade fade-out) must keep playing until
          // then, not go silent the instant stop() is called. onEnded
          // (wired above to also disconnect) fires when the scheduled stop
          // actually takes effect, so that call handles cleanup instead.
          if (effectiveWhen <= context.currentTime) {
            disconnectNodes();
          }
        },
        getFrequencyBands(bandCount) {
          analyser.getByteFrequencyData(frequencyBuffer);
          return bandsFromByteFrequencyData(frequencyBuffer, bandCount);
        },
      };

      startFns.set(node, (whenSeconds, offsetSeconds) => {
        bufferSource.start(whenSeconds, offsetSeconds);
      });
      return node;
    },

    scheduleStart(source, whenSeconds, offsetSeconds = 0) {
      const start = startFns.get(source);
      if (!start) {
        throw new Error('scheduleStart called with a SourceNode this engine did not create');
      }
      start(whenSeconds, offsetSeconds);
    },

    now() {
      return context.currentTime;
    },
  };
}
