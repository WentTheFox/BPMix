import type { AudioEngine, DecodedAudio, EngineTrackAnalysis, FileAccess, FileRef, RampSpec, SourceNode } from '@bpmix/core';
import { NativeEventEmitter, NativeModules } from 'react-native';

/**
 * Backed by a real native module (windows/Mobile/AudioEngineModule.h) using
 * Media Foundation to decode and XAudio2 to play - there is no Web-Audio
 * style API on Windows, so gain/rate automation is an approximated linear
 * step-ramp on a background thread rather than true AudioParam automation,
 * and scheduleStart's future "when" is a background sleep + Start() rather
 * than sample-accurate scheduling. See the module header comment for the
 * full list of what's approximated.
 *
 * decodeFile() resolves as soon as native has decoded and cached the
 * buffer - playback plays from that native cache via nativeBufferId, and
 * analyzeTrack() below runs against that same native cache, so neither
 * ever needs real values in DecodedAudio.channelData; it stays a
 * zero-filled placeholder sized to the real frame count (present only to
 * satisfy the shared type - transferring real sample data across the
 * bridge for nothing to read was measured costing several extra seconds
 * on a multi-minute track, so this engine simply never does it).
 */
interface NativeAudioEngine {
  now(): number;
  decodeFileMetadata(fileId: string): Promise<{
    nativeBufferId: string;
    sampleRate: number;
    numberOfChannels: number;
    frameCount: number;
    durationSeconds: number;
  }>;
  analyzeBuffer(nativeBufferId: string): Promise<EngineTrackAnalysis>;
  logFromJs(message: string): boolean;
  releaseBuffer(nativeBufferId: string): Promise<void>;
  createSource(nativeBufferId: string): string;
  scheduleStart(sourceId: string, whenSeconds: number, offsetSeconds: number): boolean;
  setGain(sourceId: string, value: number): boolean;
  setRate(sourceId: string, value: number): boolean;
  rampGain(sourceId: string, toValue: number, atTimeSeconds: number, durationSeconds: number): boolean;
  rampGainCurve(sourceId: string, values: number[], atTimeSeconds: number, durationSeconds: number): boolean;
  rampRate(sourceId: string, toValue: number, atTimeSeconds: number, durationSeconds: number): boolean;
  stop(sourceId: string, whenSeconds: number): boolean;
}

const native = NativeModules.BPMixAudioEngine as NativeAudioEngine;

const nativeBufferIdByAudio = new WeakMap<DecodedAudio, string>();

export function createAudioEngine(_fileAccess: FileAccess): AudioEngine {
  const emitter = new NativeEventEmitter(NativeModules.BPMixAudioEngine);
  const onEndedBySourceId = new Map<string, () => void>();

  emitter.addListener('playbackEnded', (sourceId: string) => {
    const onEnded = onEndedBySourceId.get(sourceId);
    onEndedBySourceId.delete(sourceId);
    onEnded?.();
  });

  return {
    async decodeFile(ref: FileRef): Promise<DecodedAudio> {
      native.logFromJs(`${Date.now()} decodeFile: calling decodeFileMetadata`);
      const meta = await native.decodeFileMetadata(ref.id);
      native.logFromJs(`${Date.now()} decodeFile: metadata resolved, ready to play`);

      const channelData: Float32Array[] = [];
      for (let ch = 0; ch < meta.numberOfChannels; ch++) {
        channelData.push(new Float32Array(meta.frameCount));
      }

      const audio: DecodedAudio = {
        sampleRate: meta.sampleRate,
        numberOfChannels: meta.numberOfChannels,
        channelData,
        durationSeconds: meta.durationSeconds,
      };
      nativeBufferIdByAudio.set(audio, meta.nativeBufferId);

      return audio;
    },

    // Runs BPM/loudness analysis natively against the already-decoded
    // buffer (see AudioEngineModule.h's `analysis` namespace) instead of
    // the shared JS analyzeTrack() - that visibly stuttered the UI thread
    // here even chunked/yielded, since RNW's old-bridge JS thread is far
    // more UI-coupled than Android/Web's. Runs directly off decodeFile's
    // native cache, no channelData transfer involved at all.
    async analyzeTrack(audio: DecodedAudio): Promise<EngineTrackAnalysis> {
      const nativeBufferId = nativeBufferIdByAudio.get(audio);
      if (!nativeBufferId) {
        throw new Error('analyzeTrack called with a DecodedAudio this engine did not decode');
      }
      return native.analyzeBuffer(nativeBufferId);
    },

    createSource(audio: DecodedAudio, onEnded?: () => void): SourceNode {
      const nativeBufferId = nativeBufferIdByAudio.get(audio);
      if (!nativeBufferId) {
        throw new Error('createSource called with a DecodedAudio this engine did not decode');
      }
      const sourceId = native.createSource(nativeBufferId);
      if (!sourceId) {
        throw new Error('Native createSource failed');
      }
      if (onEnded) {
        onEndedBySourceId.set(sourceId, onEnded);
      }

      return {
        id: sourceId,
        setGain(value: number) {
          native.setGain(sourceId, value);
        },
        rampGain(ramp: RampSpec) {
          native.rampGain(sourceId, ramp.toValue, ramp.atTimeSeconds, ramp.durationSeconds);
        },
        rampGainCurve(values: number[], atTimeSeconds: number, durationSeconds: number) {
          native.rampGainCurve(sourceId, values, atTimeSeconds, durationSeconds);
        },
        setRate(value: number) {
          native.setRate(sourceId, value);
        },
        rampRate(ramp: RampSpec) {
          native.rampRate(sourceId, ramp.toValue, ramp.atTimeSeconds, ramp.durationSeconds);
        },
        stop(whenSeconds?: number) {
          onEndedBySourceId.delete(sourceId);
          native.stop(sourceId, whenSeconds ?? native.now());
        },
      };
    },

    scheduleStart(source: SourceNode, whenSeconds: number, offsetSeconds = 0) {
      native.scheduleStart(source.id, whenSeconds, offsetSeconds);
    },

    now(): number {
      return native.now();
    },
  };
}
