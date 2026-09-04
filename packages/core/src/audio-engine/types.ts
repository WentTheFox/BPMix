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
  /**
   * Optional: real-time frequency-band loudness of the decoded signal,
   * tapped *before* this source's own gain node - so it reflects the music
   * itself (the raw file's dynamics) rather than whatever fade/crossfade/
   * volume gain happens to be applied right now, which callers likely
   * already have (e.g. the UI's own currentGain/nextGain crossfade
   * fraction) and want to show as a separate signal. Returns `bandCount`
   * values in [0,1], log-spaced low-to-high (see
   * audio-engine/frequencyBands' bandsFromByteFrequencyData, which engines
   * backed by a Web-Audio-style AnalyserNode can implement this with
   * directly). Engines without a live analyser tap (Windows, currently)
   * simply don't implement this; callers must treat it as bandCount zeros
   * when absent.
   */
  getFrequencyBands?(bandCount: number): number[];
}

/** Structurally identical to analysis/analyzeTrack's TrackAnalysis - duplicated here (rather than imported) so audio-engine/types doesn't depend on the analysis module. */
export interface EngineTrackAnalysis {
  normalizationGain: number;
}

export interface AudioEngine {
  /**
   * Decodes an entire file to PCM. Callers slice the first/last-30s
   * windows themselves - see the plan's "decode whole file once" note.
   */
  decodeFile(ref: FileRef): Promise<DecodedAudio>;

  /**
   * Optional: resolves once `audio.channelData` holds real sample data
   * usable for analysis, if it might not yet when decodeFile() resolves.
   * Exists for engines (Windows) whose decodeFile() returns as soon as
   * playback is possible - which never reads channelData, it plays from
   * a native-cached buffer - filling in real channelData values into the
   * same typed arrays afterward in the background, since that transfer
   * alone can take several seconds on a multi-minute track and playback
   * shouldn't have to wait for it. Engines that always return full real
   * data (Android, Web) simply don't implement this; callers that care
   * about analysis correctness (PlaylistPlayer.decodeAndNotify) must
   * await it before reading channelData, treating it as already-resolved
   * when absent.
   */
  awaitAnalysisReady?(audio: DecodedAudio): Promise<void>;

  /**
   * Optional: an engine-native implementation of BPM/loudness analysis
   * (analysis/analyzeTrack's algorithm), for platforms where running that
   * analysis in JS visibly stutters the UI thread - Windows, whose old-RN-
   * bridge architecture blocks UI responsiveness on JS work unlike Android/
   * Web's genuinely separate JS and UI threads. When present,
   * ensureTrackAnalyzed() uses this instead of the shared JS analyzeTrack(),
   * running against the engine's own already-decoded native buffer rather
   * than audio.channelData. Engines without a stutter problem (Android,
   * Web) simply don't implement this.
   */
  analyzeTrack?(audio: DecodedAudio): Promise<EngineTrackAnalysis>;

  /**
   * Optional: does whatever expensive one-time work createSource() would
   * otherwise do lazily on first use, ahead of time - for Web Audio-style
   * engines (Android, Web), that's building the native AudioBuffer
   * (allocating it and copying every channel's PCM into it), which
   * createSource() only does once per DecodedAudio and then caches, but
   * with no way to trigger that caching early. Left undone, a decode that
   * finished well ahead of time via preload still stalls the JS thread for
   * that copy at the moment a track actually needs to start playing - i.e.
   * exactly when a crossfade/track-swap animation is running (confirmed
   * on-device: a multi-minute stereo track's PCM copy is a real,
   * user-visible stall). Calling this once preload has a DecodedAudio in
   * hand moves that cost off the critical transition path. Windows doesn't
   * implement this - its decodeFile() already plays from a native-cached
   * buffer prepared ahead of time, so there's no equivalent lazy step to
   * pre-empt.
   */
  prepareBuffer?(audio: DecodedAudio): void;

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
