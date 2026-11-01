import { parentPort, workerData } from 'node:worker_threads';
import { analyzeTrack } from '@beatseam/core';
import { decodeWithFfmpeg } from './ffmpegDecoder.js';

// Runs in its own thread so the DSP (and the big PCM buffer) never blocks the
// API's event loop. One job per worker; the pool in AnalysisPool spawns these.
const { absolutePath } = workerData as { absolutePath: string };
decodeWithFfmpeg(absolutePath)
  .then((audio) => analyzeTrack(audio))
  .then((result) => parentPort!.postMessage({ ok: true, result }))
  .catch((err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }));
