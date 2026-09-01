import type { AudioEngine, DecodedAudio, FileAccess, FileRef, RampSpec, SourceNode } from '@bpmix/core';
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

    createSource(audio: DecodedAudio, onEnded?: () => void): SourceNode {
      const buffer = getOrCreateBuffer(context, audio);
      const bufferSource: AudioBufferSourceNode = context.createBufferSource({ pitchCorrection: false });
      bufferSource.buffer = buffer;
      const gainNode = context.createGain();
      bufferSource.connect(gainNode);
      gainNode.connect(context.destination);
      if (onEnded) {
        bufferSource.onEnded = () => onEnded();
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
        setRate(value) {
          bufferSource.playbackRate.value = value;
        },
        rampRate(ramp: RampSpec) {
          const endTime = ramp.atTimeSeconds + ramp.durationSeconds;
          bufferSource.playbackRate.setValueAtTime(bufferSource.playbackRate.value, ramp.atTimeSeconds);
          bufferSource.playbackRate.linearRampToValueAtTime(ramp.toValue, endTime);
        },
        stop(whenSeconds) {
          try {
            bufferSource.stop(whenSeconds ?? context.currentTime);
          } catch {
            // Already stopped/never started - fine, this is a best-effort stop.
          }
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
