import { EventEmitter } from 'node:events';
import { availableParallelism } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TrackRecord } from '@beatseam/core';
import { DatabaseService } from '../db/database.module.js';
import { JobNotifier } from './jobNotifier.js';
import { JobQueue, type ClaimedJob, type JobStage, type RetryPolicy } from './jobQueue.js';
import { TrackProcessor } from './trackProcessor.js';

export interface WorkerStats {
  workers: number;
  /** Since this process started. */
  succeeded: number;
  failedAttempts: number;
  skipped: number;
  inFlight: number;
}

const LEASE_MS = 15 * 60_000;

export function scanWorkerCount(config: ConfigService): number {
  return Math.max(1, Number(config.get('BEATSEAM_SCAN_WORKERS') ?? Math.min(4, availableParallelism())));
}

/**
 * N worker loops that pull per-track jobs off the Postgres queue. Idle loops
 * sleep until a NOTIFY (work queued/finished, here or in another server
 * process) or until a known backoff/lease time arrives - nothing polls.
 */
@Injectable()
export class ScanWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ScanWorkers');
  readonly queue: JobQueue;
  /** Emits 'changed' whenever the scan's state may have moved (a job queued or finished, a scan started or ended), so the admin page can follow along without asking. */
  readonly changes = new EventEmitter();
  readonly policy: RetryPolicy;
  private readonly workerCount: number;
  private readonly notifier: JobNotifier;
  private readonly instanceId = randomUUID().slice(0, 8);
  private stopped = true;
  private loops: Promise<void>[] = [];
  private generation = 0;
  private sleepers: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly stats: WorkerStats;

  constructor(
    private readonly db: DatabaseService,
    private readonly processor: TrackProcessor,
    config: ConfigService,
  ) {
    this.queue = new JobQueue(db.prisma);
    this.workerCount = scanWorkerCount(config);
    this.policy = {
      maxAttempts: Math.max(1, Number(config.get('BEATSEAM_SCAN_MAX_ATTEMPTS') ?? 3)),
      backoffBaseMs: Number(config.get('BEATSEAM_SCAN_BACKOFF_MS') ?? 30_000),
      backoffFactor: 4,
    };
    this.stats = { workers: this.workerCount, succeeded: 0, failedAttempts: 0, skipped: 0, inFlight: 0 };
    this.notifier = new JobNotifier(db.connectionString, (err) => this.logger.warn(`Job notifications interrupted: ${String(err)}`));
    this.notifier.on('wake', () => {
      this.wake();
      this.changes.emit('changed');
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.notifier.start();
    this.loops = Array.from({ length: this.workerCount }, (_, i) => this.loop(`${this.instanceId}-${i + 1}`));
    this.logger.log(`Started ${this.workerCount} scan worker(s) (max ${this.policy.maxAttempts} attempts per track)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.wake();
    await Promise.all(this.loops);
    this.loops = [];
    await this.notifier.stop();
  }

  getStats(): WorkerStats {
    return { ...this.stats };
  }

  /** Resolves once no job is running or due. Tracks waiting out a retry backoff don't hold it up. */
  async waitUntilSettled(): Promise<void> {
    for (;;) {
      const generation = this.generation;
      if (await this.queue.isSettled()) return;
      if (generation === this.generation) await new Promise<void>((resolve) => this.sleepers.push(resolve));
    }
  }

  wake(): void {
    this.generation++;
    const sleepers = this.sleepers;
    this.sleepers = [];
    for (const wakeUp of sleepers) wakeUp();
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.stopped) {
      const generation = this.generation;
      let job: ClaimedJob | null;
      try {
        job = await this.queue.claim(workerId, LEASE_MS);
      } catch (err) {
        this.logger.error(`Claiming a job failed: ${String(err)}`);
        await this.sleep(5_000);
        continue;
      }
      if (job) {
        await this.run(workerId, job);
        continue;
      }
      await this.armTimer();
      // A wake that landed while we were claiming must not be slept through.
      if (generation === this.generation && !this.stopped) await new Promise<void>((resolve) => this.sleepers.push(resolve));
    }
  }

  /** Wake exactly when the next backoff ends or lease expires. */
  private async armTimer(): Promise<void> {
    const next = await this.queue.nextWakeAt().catch(() => null);
    if (this.timer) clearTimeout(this.timer);
    this.timer = next ? setTimeout(() => this.wake(), Math.max(0, next.getTime() - Date.now())) : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async run(workerId: string, job: ClaimedJob): Promise<void> {
    const startedAt = Date.now();
    let stage: JobStage = 'worker';
    this.stats.inFlight++;
    try {
      if (job.attempts > this.policy.maxAttempts) {
        // Claimed again after its lease expired, past the limit: workers keep dying on this track.
        throw new Error('Worker lease expired repeatedly (a worker likely crashed while processing this track)');
      }
      const row = await this.db.prisma.track.findUnique({ where: { fileId: job.fileId } });
      if (!row || row.missing) {
        await this.queue.complete(job.fileId, workerId);
        return;
      }
      const track: TrackRecord = {
        fileId: row.fileId,
        rootId: row.rootId,
        relativePath: row.relativePath,
        sizeBytes: Number(row.sizeBytes),
        lastModifiedMs: row.lastModifiedMs,
      };
      if (!job.metadataDone) {
        stage = 'metadata';
        await this.processor.readMetadata(track);
        await this.queue.markStageDone(job.fileId, workerId, 'metadata');
      }
      if (!job.analysisDone) {
        stage = 'analysis';
        await this.processor.analyze(track);
        await this.queue.markStageDone(job.fileId, workerId, 'analysis');
      }
      await this.queue.complete(job.fileId, workerId);
      this.stats.succeeded++;
      this.logger.debug(`${job.fileId}: done in ${Date.now() - startedAt}ms (attempt ${job.attempts})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.failedAttempts++;
      try {
        const { willRetry } = await this.queue.fail(job, workerId, stage, message, this.policy);
        if (willRetry) {
          const retryInMs = this.policy.backoffBaseMs * this.policy.backoffFactor ** (job.attempts - 1);
          this.logger.warn(`${job.fileId}: ${stage} failed (attempt ${job.attempts}/${this.policy.maxAttempts}), retrying in ${Math.round(retryInMs / 1000)}s: ${message}`);
        } else {
          this.stats.skipped++;
          this.logger.error(`${job.fileId}: ${stage} failed on attempt ${job.attempts}/${this.policy.maxAttempts}, skipping this track until it changes: ${message}`);
        }
      } catch (recordErr) {
        // The lease will expire and the job gets picked up again.
        this.logger.error(`${job.fileId}: could not record failure (${String(recordErr)}); original error: ${message}`);
      }
    } finally {
      this.stats.inFlight--;
    }
  }
}
