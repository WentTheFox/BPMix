import type { AudioEngine, DecodedAudio, FileAccess, FileRef, RampSpec, SourceNode } from '@bpmix/core';

function decodedAudioToBuffer(context: BaseAudioContext, decoded: DecodedAudio): AudioBuffer {
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
 * underlying AudioBufferSourceNode. scheduleStart is a separate AudioEngine
 * method from createSource (so both can be swapped/tested independently),
 * so this is how the engine reconnects a SourceNode back to its real node
 * without putting engine-internal state on the public SourceNode type.
 */
const startFns = new WeakMap<SourceNode, (whenSeconds: number, offsetSeconds: number) => void>();

/**
 * Native AudioBuffers are cached per decoded track (keyed by the DecodedAudio
 * object TrackPlayer holds onto for the track's whole loaded lifetime), not
 * rebuilt on every createSource() call - see the identical, more critical
 * note in the Android adapter (rebuilding one here is just wasteful; on
 * Android it crashed the app under rapid repeated seeking).
 */
const nativeBufferCache = new WeakMap<DecodedAudio, AudioBuffer>();

function getOrCreateBuffer(context: BaseAudioContext, decoded: DecodedAudio): AudioBuffer {
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
      // synchronous per-channel copyToChannel) now instead of leaving it
      // for whenever createSource() first needs this audio.
      getOrCreateBuffer(context, audio);
    },

    createSource(audio: DecodedAudio, onEnded?: () => void): SourceNode {
      const buffer = getOrCreateBuffer(context, audio);
      const bufferSource = context.createBufferSource();
      bufferSource.buffer = buffer;
      const gainNode = context.createGain();
      bufferSource.connect(gainNode);
      gainNode.connect(context.destination);

      // Browsers release a finished one-shot AudioBufferSourceNode on their
      // own, but explicitly disconnecting keeps this adapter's node lifetime
      // handling identical to the Android adapter (see its longer note),
      // where a native, non-JS-GC-tracked graph reference makes this
      // required, not just tidy.
      const disconnectNodes = () => {
        bufferSource.disconnect();
        gainNode.disconnect();
      };

      if (onEnded) {
        bufferSource.onended = () => {
          onEnded();
          disconnectNodes();
        };
      }

      const node: SourceNode = {
        id: `web-source-${nextId++}`,
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
          // then, not go silent the instant stop() is called. onended
          // (wired above to also disconnect) fires when the scheduled stop
          // actually takes effect, so that call handles cleanup instead.
          if (effectiveWhen <= context.currentTime) {
            disconnectNodes();
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
