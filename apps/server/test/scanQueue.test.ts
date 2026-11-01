import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/scanner/jobQueue.js';
import { createScanStack, realAnalyze, resetDatabase, testPrisma, type AnalyzeFn, type ScanStack } from './scanStack.js';

let base: string;
const stacks: ScanStack[] = [];
const trackNames = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, '0')}.mp3`);

async function stack(options: { analyze?: AnalyzeFn; env?: Record<string, string> } = {}): Promise<ScanStack> {
  const s = await createScanStack({ base, ...options });
  stacks.push(s);
  return s;
}

const jobFor = (name: string) => testPrisma.trackJob.findUniqueOrThrow({ where: { fileId: `Music:${name}` } });

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'beatseam-queue-'));
  await mkdir(path.join(base, 'Music'));
  trackNames.forEach((name, i) => {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${200 + i * 20}:duration=1`, '-metadata', `title=${name}`, path.join(base, 'Music', name)]);
  });
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((s) => s.stop()));
});

afterAll(async () => {
  await testPrisma.$disconnect();
  await rm(base, { recursive: true, force: true });
});

describe('scan job queue', () => {
  it('hands each song to exactly one worker, even across two worker pools sharing the database', async () => {
    const calls = new Map<string, number>();
    const analyze: AnalyzeFn = async (absolutePath) => {
      calls.set(path.basename(absolutePath), (calls.get(path.basename(absolutePath)) ?? 0) + 1);
      return realAnalyze(absolutePath);
    };
    // Two independent pools (as two server processes would be), three workers each.
    const a = await stack({ analyze, env: { BEATSEAM_SCAN_WORKERS: '3' } });
    await stack({ analyze, env: { BEATSEAM_SCAN_WORKERS: '3' } });

    const summary = await a.scanner.scanAll();

    expect(summary.jobs).toMatchObject({ done: 12, skipped: 0 });
    expect([...calls.keys()].sort()).toEqual(trackNames);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(await testPrisma.trackJob.findMany({ select: { attempts: true } })).toEqual(trackNames.map(() => ({ attempts: 1 })));
    expect(await testPrisma.trackJobFailure.count()).toBe(0);
  });

  it('retries a failing song with backoff and records each failed attempt', async () => {
    let attempts = 0;
    const flaky: AnalyzeFn = async (absolutePath) => {
      if (path.basename(absolutePath) === 't03.mp3' && ++attempts < 3) throw new Error(`transient failure #${attempts}`);
      return realAnalyze(absolutePath);
    };
    const { scanner } = await stack({ analyze: flaky });

    const summary = await scanner.scanAll();

    expect(summary.jobs).toMatchObject({ done: 12, skipped: 0 });
    expect(await jobFor('t03.mp3')).toMatchObject({ state: 'DONE', attempts: 3, metadataDone: true, analysisDone: true, lastError: null });
    const failures = await testPrisma.trackJobFailure.findMany({ orderBy: { id: 'asc' } });
    expect(failures.map((f) => [f.fileId, f.stage, f.attempt, f.willRetry, f.error])).toEqual([
      ['Music:t03.mp3', 'analysis', 1, true, 'transient failure #1'],
      ['Music:t03.mp3', 'analysis', 2, true, 'transient failure #2'],
    ]);
  });

  it('skips a hopeless song after the last attempt, and leaves it skipped on later scans until it changes', async () => {
    let badCalls = 0;
    const analyze: AnalyzeFn = async (absolutePath) => {
      if (path.basename(absolutePath) === 't05.mp3') {
        badCalls++;
        throw new Error('ffmpeg exited with 183: Invalid data found when processing input');
      }
      return realAnalyze(absolutePath);
    };
    const { scanner, workers } = await stack({ analyze });

    const first = await scanner.scanAll();
    expect(first.jobs).toMatchObject({ done: 11, skipped: 1 });
    expect(badCalls).toBe(3); // BEATSEAM_SCAN_MAX_ATTEMPTS defaults to 3
    expect(await jobFor('t05.mp3')).toMatchObject({ state: 'SKIPPED', attempts: 3, lastErrorStage: 'analysis' });
    expect((await jobFor('t05.mp3')).skippedAt).not.toBeNull();
    // Its metadata stage succeeded and is kept; only analysis was hopeless.
    expect(await testPrisma.trackMetadata.findUnique({ where: { fileId: 'Music:t05.mp3' } })).not.toBeNull();

    // A newer scan: nothing changed, so the hopeless song is not queued or attempted again.
    const second = await scanner.scanAll();
    expect(second.queued).toBe(0);
    expect(badCalls).toBe(3);
    expect(second.jobs.skipped).toBe(1);
    expect(workers.getStats().skipped).toBe(1);

    // Touching the file changes its fingerprint, which gives it a fresh set of attempts.
    const bad = path.join(base, 'Music', 't05.mp3');
    await utimes(bad, new Date(), new Date(Date.now() + 60_000));
    const third = await scanner.scanAll();
    expect(third.queued).toBe(1);
    expect(badCalls).toBe(6);
    expect(third.jobs.skipped).toBe(1);
  });

  it('retrySkipped gives skipped songs a fresh set of attempts', async () => {
    let healthy = false;
    const analyze: AnalyzeFn = async (absolutePath) => {
      if (path.basename(absolutePath) === 't07.mp3' && !healthy) throw new Error('decoder broken');
      return realAnalyze(absolutePath);
    };
    const { scanner, workers } = await stack({ analyze });
    await scanner.scanAll();
    expect((await jobFor('t07.mp3')).state).toBe('SKIPPED');

    healthy = true;
    expect(await scanner.retrySkipped()).toBe(1);
    await workers.waitUntilSettled();

    expect(await jobFor('t07.mp3')).toMatchObject({ state: 'DONE', attempts: 1 });
    expect(await scanner.retrySkipped()).toBe(0);
  });

  it('lets another worker take over a job whose lease expired, and skips one that keeps killing workers', async () => {
    const { scanner, workers } = await stack({ env: { BEATSEAM_SCAN_MAX_ATTEMPTS: '2' } });
    await scanner.scanAll();
    await testPrisma.trackJob.deleteMany();
    // t01's worker "died" mid-job: RUNNING with a lease in the past.
    await testPrisma.trackJob.create({
      data: { fileId: 'Music:t01.mp3', fingerprint: 'stale', state: 'RUNNING', attempts: 1, lockedBy: 'dead-worker', lockExpiresAt: new Date(Date.now() - 1000) },
    });
    // t02 has already burned through its attempts that way.
    await testPrisma.trackJob.create({
      data: { fileId: 'Music:t02.mp3', fingerprint: 'stale', state: 'RUNNING', attempts: 2, lockedBy: 'dead-worker', lockExpiresAt: new Date(Date.now() - 1000) },
    });
    workers.wake();
    await workers.waitUntilSettled();

    expect(await jobFor('t01.mp3')).toMatchObject({ state: 'DONE', attempts: 2 });
    const t02 = await jobFor('t02.mp3');
    expect(t02.state).toBe('SKIPPED');
    expect(t02.lastError).toMatch(/lease expired repeatedly/);
  });

  it('never claims one job twice under concurrent claims', async () => {
    const queue = new JobQueue(testPrisma);
    await queue.enqueue(trackNames.map((name) => ({ fileId: `Music:${name}`, fingerprint: 'x' })));
    const claimed = (await Promise.all(Array.from({ length: 40 }, (_, i) => queue.claim(`w${i}`, 60_000)))).filter((j) => j !== null);
    expect(claimed.map((j) => j.fileId).sort()).toEqual(trackNames.map((n) => `Music:${n}`));
    expect(await queue.claim('late', 60_000)).toBeNull();
  });

  it('does not re-queue a finished song or disturb a running one when the fingerprint is unchanged', async () => {
    const queue = new JobQueue(testPrisma);
    expect(await queue.enqueue([{ fileId: 'Music:a.mp3', fingerprint: '1' }])).toBe(1);
    expect(await queue.enqueue([{ fileId: 'Music:a.mp3', fingerprint: '1' }])).toBe(0);
    const job = (await queue.claim('w', 60_000))!;
    await queue.complete(job.fileId, 'w');
    expect(await queue.enqueue([{ fileId: 'Music:a.mp3', fingerprint: '1' }])).toBe(0);
    expect(await queue.enqueue([{ fileId: 'Music:a.mp3', fingerprint: '2' }])).toBe(1);
    await queue.claim('w', 60_000);
    // A change that lands while it's running waits for the next scan rather than yanking the job.
    expect(await queue.enqueue([{ fileId: 'Music:a.mp3', fingerprint: '3' }])).toBe(0);
  });
});
