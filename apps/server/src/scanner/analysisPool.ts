import { Worker } from 'node:worker_threads';
import type { TrackAnalysis } from '@bpmix/core';

export type AnalyzeFile = (absolutePath: string) => Promise<TrackAnalysis>;

/** Runs analyses on worker threads, at most `size` at a time. */
export function createAnalysisPool(size: number, workerUrl: URL): AnalyzeFile {
  let active = 0;
  const waiting: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (active < size) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  return async (absolutePath) => {
    await acquire();
    try {
      return await new Promise<TrackAnalysis>((resolve, reject) => {
        const worker = new Worker(workerUrl, { workerData: { absolutePath } });
        worker.once('message', (msg: { ok: true; result: TrackAnalysis } | { ok: false; error: string }) => {
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error));
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (code !== 0) reject(new Error(`analysis worker exited with ${code}`));
        });
      });
    } finally {
      release();
    }
  };
}
