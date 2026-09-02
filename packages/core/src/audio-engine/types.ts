import type { FileRef } from '../file-access/types';

/** Decoded PCM audio, platform-independent. */
export interface DecodedAudio {
  sampleRate: number;
  numberOfChannels: number;
  /** One Float32Array per channel. */
  channelData: Float32Array[];
  durationSeconds: number;
}

/** A linear ramp automation, mirroring the Web Audio AudioParam shape we actually need. */
export interface RampSpec {
  toValue: number;
  atTimeSeconds: number;
  durationSeconds: number;
}

export interface SourceNode {
  readonly id: string;
  setGain(value: number): void;
  rampGain(ramp: RampSpec): void;
  /**
   * Schedules an arbitrary gain curve (evenly-spaced sample values) over
   * [atTimeSeconds, atTimeSeconds+durationSeconds), via the engine's native
   * curve automation (Web Audio's setValueCurveAtTime or equivalent) - used
   * for the Stage 7 crossfade's equal-power fade, since a single linear
   * rampGain segment can't express that shape (and a JS-side approximation
   * built from several rampGain calls back-to-back doesn't work either:
   * each call anchors itself to the *current* live gain value at call time,
   * not to where an in-flight scheduled ramp would be by then).
   */
  rampGainCurve(values: number[], atTimeSeconds: number, durationSeconds: number): void;
  setRate(value: number): void;
  rampRate(ramp: RampSpec): void;
  stop(whenSeconds?: number): void;
}

export interface AudioEngine {
  /**
   * Decodes an entire file to PCM. Callers slice the first/last-30s
   * windows themselves - see the plan's "decode whole file once" note.
   */
  decodeFile(ref: FileRef): Promise<DecodedAudio>;

  /**
   * A SourceNode is one-shot: once stopped it can't be restarted, so pause/
   * seek/resume are implemented by the caller (see TrackPlayer) stopping the
   * current source and creating a new one at the desired offset.
   */
  createSource(audio: DecodedAudio, onEnded?: () => void): SourceNode;

  /**
   * Schedules playback to start at an engine-clock time (seconds), beginning
   * at offsetSeconds into the decoded buffer - for sample-accurate overlap
   * and for resuming/seeking mid-track.
   */
  scheduleStart(source: SourceNode, whenSeconds: number, offsetSeconds?: number): void;

  /** Engine's current transport clock, in seconds. */
  now(): number;
}
