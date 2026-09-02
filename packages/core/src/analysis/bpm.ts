export interface BpmEstimate {
  bpm: number;
  /** Normalized peak autocorrelation strength, roughly in [0, 1] - how confidently periodic the estimate is. */
  confidence: number;
  /**
   * Seconds from the start of the analyzed window to the first beat that
   * lines up with the detected period - the beat *phase*, not just the
   * tempo. bpm alone says how far apart beats are; this says where one
   * actually falls, which is what a transition needs to align two tracks'
   * beat grids rather than just matching their rates.
   */
  firstBeatOffsetSeconds: number;
}

const MIN_BPM = 60;
const MAX_BPM = 200;
/** ~23ms energy windows, 50% overlap - short enough to track individual beats, long enough to smooth out noise. */
const ENVELOPE_WINDOW_SAMPLES = 1024;
const ENVELOPE_HOP_SAMPLES = 512;

/** Energy-per-window envelope of a mono signal, at a much lower "envelope rate" than the original sample rate. */
function computeEnergyEnvelope(samples: Float32Array): Float32Array {
  if (samples.length < ENVELOPE_WINDOW_SAMPLES) return new Float32Array(0);
  const frameCount = Math.floor((samples.length - ENVELOPE_WINDOW_SAMPLES) / ENVELOPE_HOP_SAMPLES) + 1;
  const envelope = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * ENVELOPE_HOP_SAMPLES;
    let sumSquares = 0;
    for (let i = 0; i < ENVELOPE_WINDOW_SAMPLES; i++) {
      const sample = samples[start + i] ?? 0;
      sumSquares += sample * sample;
    }
    envelope[frame] = sumSquares / ENVELOPE_WINDOW_SAMPLES;
  }
  return envelope;
}

/** Half-wave-rectified first difference - an "onset strength" signal that peaks sharply at beat attacks, not sustained energy. */
function onsetStrength(envelope: Float32Array): Float32Array {
  const onset = new Float32Array(envelope.length);
  for (let i = 1; i < envelope.length; i++) {
    const current = envelope[i] ?? 0;
    const previous = envelope[i - 1] ?? 0;
    onset[i] = Math.max(0, current - previous);
  }
  return onset;
}

function autocorrelateAtLag(signal: Float32Array, mean: number, lag: number): number {
  let sum = 0;
  const n = signal.length - lag;
  for (let i = 0; i < n; i++) {
    sum += ((signal[i] ?? 0) - mean) * ((signal[i + lag] ?? 0) - mean);
  }
  return sum;
}

/**
 * Given the detected beat period (bestLag, in envelope frames), finds which
 * phase offset within that period best lines up with the onset signal's
 * peaks - i.e. a comb filter: for each candidate phase, sum the onset
 * strength at phase, phase+period, phase+2*period, ... and keep the phase
 * with the highest sum. That phase is where an actual beat falls, not just
 * how far apart beats are.
 */
function findBestPhase(onset: Float32Array, period: number): number {
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < period; phase++) {
    let sum = 0;
    for (let i = phase; i < onset.length; i += period) {
      sum += onset[i] ?? 0;
    }
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

/**
 * Windowed energy envelope + autocorrelation BPM estimator, per the plan -
 * plus a beat-phase pass on top, since a transition needs to know where a
 * beat actually falls in the analyzed window, not just the track's tempo.
 * Operates on a single mono channel (see analyzeTrack.ts for the mono
 * downmix) over whatever PCM slice the caller passes in.
 */
export function estimateBpm(samples: Float32Array, sampleRate: number): BpmEstimate {
  const envelope = computeEnergyEnvelope(samples);
  const onset = onsetStrength(envelope);
  const envelopeRate = sampleRate / ENVELOPE_HOP_SAMPLES;

  const minLag = Math.max(1, Math.round((envelopeRate * 60) / MAX_BPM));
  const maxLag = Math.min(onset.length - 1, Math.round((envelopeRate * 60) / MIN_BPM));

  if (onset.length === 0 || minLag >= maxLag) {
    return { bpm: 0, confidence: 0, firstBeatOffsetSeconds: 0 };
  }

  let mean = 0;
  for (let i = 0; i < onset.length; i++) mean += onset[i] ?? 0;
  mean /= onset.length;

  const zeroLagEnergy = autocorrelateAtLag(onset, mean, 0);
  if (zeroLagEnergy <= 0) {
    return { bpm: 0, confidence: 0, firstBeatOffsetSeconds: 0 };
  }

  let bestLag = minLag;
  let bestValue = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const value = autocorrelateAtLag(onset, mean, lag);
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }

  const bpm = (envelopeRate * 60) / bestLag;
  const confidence = Math.min(1, Math.max(0, bestValue / zeroLagEnergy));
  const bestPhase = findBestPhase(onset, bestLag);
  const firstBeatOffsetSeconds = (bestPhase * ENVELOPE_HOP_SAMPLES) / sampleRate;

  return { bpm, confidence, firstBeatOffsetSeconds };
}
