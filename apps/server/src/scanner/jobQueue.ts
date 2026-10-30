import type { PrismaClient } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';

/** Postgres NOTIFY channel that wakes idle workers (in this process or any other) when work appears. */
export const JOB_CHANNEL = 'bpmix_track_jobs';

export type JobStage = 'metadata' | 'analysis' | 'worker';

export interface ClaimedJob {
  fileId: string;
  fingerprint: string;
  /** Includes this claim. */
  attempts: number;
  metadataDone: boolean;
  analysisDone: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  /** Delay before the second attempt; each further attempt waits `backoffFactor` times longer. */
  backoffBaseMs: number;
  backoffFactor: number;
}

export interface JobCounts {
  pending: number;
  /** PENDING jobs that have failed at least once and are waiting out their backoff. */
  retrying: number;
  running: number;
  done: number;
  skipped: number;
}

export interface JobSummary {
  fileId: string;
  state: 'PENDING' | 'RUNNING' | 'DONE' | 'SKIPPED';
  attempts: number;
  lastError: string | null;
  lastErrorStage: string | null;
  skippedAt: Date | null;
  updatedAt: Date;
}

export interface FailureSummary {
  id: number;
  fileId: string;
  stage: string;
  attempt: number;
  error: string;
  willRetry: boolean;
  workerId: string;
  at: Date;
}

const MAX_ERROR_LENGTH = 2000;

/**
 * The scan queue in Postgres: one row per track (so a song is queued at most
 * once), claimed with FOR UPDATE SKIP LOCKED (so it's handed to at most one
 * worker at a time, across threads and across server processes), with a lease
 * so a job whose worker died is picked up again.
 */
export class JobQueue {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Queues tracks whose fingerprint is new or changed. A job already DONE or
   * SKIPPED for the same fingerprint is left alone (that's what keeps hopeless
   * songs skipped on later scans), and one currently RUNNING isn't disturbed.
   */
  async enqueue(tracks: readonly { fileId: string; fingerprint: string }[]): Promise<number> {
    if (tracks.length === 0) return 0;
    const fileIds = tracks.map((t) => t.fileId);
    const fingerprints = tracks.map((t) => t.fingerprint);
    const queued = await this.prisma.$executeRaw`
      INSERT INTO track_jobs (file_id, fingerprint, updated_at)
      SELECT file_id, fingerprint, now() FROM unnest(${fileIds}::text[], ${fingerprints}::text[]) AS t(file_id, fingerprint)
      ON CONFLICT (file_id) DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint, state = 'PENDING', attempts = 0, run_after = now(),
        locked_by = NULL, lock_expires_at = NULL, metadata_done = false, analysis_done = false,
        last_error = NULL, last_error_stage = NULL, skipped_at = NULL, finished_at = NULL, updated_at = now()
      WHERE track_jobs.fingerprint <> EXCLUDED.fingerprint AND track_jobs.state <> 'RUNNING'`;
    if (queued > 0) await this.notify();
    return queued;
  }

  /** Hands out the next due job (or an expired-lease one) to `workerId`, counting this as an attempt. */
  async claim(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    const rows = await this.prisma.$queryRaw<
      { file_id: string; fingerprint: string; attempts: number; metadata_done: boolean; analysis_done: boolean }[]
    >`
      WITH next AS (
        SELECT file_id FROM track_jobs
        WHERE (state = 'PENDING' AND run_after <= now()) OR (state = 'RUNNING' AND lock_expires_at < now())
        ORDER BY run_after, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE track_jobs j SET
        state = 'RUNNING', attempts = j.attempts + 1, locked_by = ${workerId},
        lock_expires_at = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      FROM next WHERE j.file_id = next.file_id
      RETURNING j.file_id, j.fingerprint, j.attempts, j.metadata_done, j.analysis_done`;
    const row = rows[0];
    return row
      ? { fileId: row.file_id, fingerprint: row.fingerprint, attempts: row.attempts, metadataDone: row.metadata_done, analysisDone: row.analysis_done }
      : null;
  }

  /** Records a finished stage so a retry resumes after it. Ignored if the job was taken over meanwhile. */
  async markStageDone(fileId: string, workerId: string, stage: 'metadata' | 'analysis'): Promise<void> {
    if (stage === 'metadata') {
      await this.prisma.$executeRaw`UPDATE track_jobs SET metadata_done = true, updated_at = now() WHERE file_id = ${fileId} AND locked_by = ${workerId} AND state = 'RUNNING'`;
    } else {
      await this.prisma.$executeRaw`UPDATE track_jobs SET analysis_done = true, updated_at = now() WHERE file_id = ${fileId} AND locked_by = ${workerId} AND state = 'RUNNING'`;
    }
  }

  async complete(fileId: string, workerId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE track_jobs SET state = 'DONE', locked_by = NULL, lock_expires_at = NULL, last_error = NULL, last_error_stage = NULL,
        finished_at = now(), updated_at = now()
      WHERE file_id = ${fileId} AND locked_by = ${workerId} AND state = 'RUNNING'`;
    await this.notify();
  }

  /**
   * Records a failed attempt. Below the attempt limit the job goes back to
   * PENDING after a backoff; at the limit it's SKIPPED, which later scans
   * leave alone until the file changes or an admin retries it.
   */
  async fail(job: ClaimedJob, workerId: string, stage: JobStage, error: string, policy: RetryPolicy): Promise<{ willRetry: boolean }> {
    const message = error.slice(0, MAX_ERROR_LENGTH);
    const willRetry = job.attempts < policy.maxAttempts;
    await this.prisma.trackJobFailure.create({
      data: { fileId: job.fileId, stage, attempt: job.attempts, error: message, willRetry, workerId },
    });
    if (willRetry) {
      const backoffMs = policy.backoffBaseMs * policy.backoffFactor ** (job.attempts - 1);
      await this.prisma.$executeRaw`
        UPDATE track_jobs SET state = 'PENDING', locked_by = NULL, lock_expires_at = NULL, last_error = ${message}, last_error_stage = ${stage},
          run_after = now() + ${backoffMs} * interval '1 millisecond', updated_at = now()
        WHERE file_id = ${job.fileId} AND locked_by = ${workerId} AND state = 'RUNNING'`;
    } else {
      await this.prisma.$executeRaw`
        UPDATE track_jobs SET state = 'SKIPPED', locked_by = NULL, lock_expires_at = NULL, last_error = ${message}, last_error_stage = ${stage},
          skipped_at = now(), updated_at = now()
        WHERE file_id = ${job.fileId} AND locked_by = ${workerId} AND state = 'RUNNING'`;
    }
    await this.notify();
    return { willRetry };
  }

  /** When the next job becomes claimable (a backoff ending or a lease expiring), or null if nothing is waiting. */
  async nextWakeAt(): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<{ at: Date | null }[]>`
      SELECT MIN(CASE WHEN state = 'PENDING' THEN run_after ELSE lock_expires_at END) AS at
      FROM track_jobs WHERE state IN ('PENDING', 'RUNNING')`;
    return row?.at ?? null;
  }

  /**
   * No job running (including one whose lease expired and is up for takeover)
   * and none due right now. Jobs still waiting out a retry backoff don't count.
   */
  async isSettled(): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<{ active: bigint }[]>`
      SELECT COUNT(*) AS active FROM track_jobs WHERE (state = 'PENDING' AND run_after <= now()) OR state = 'RUNNING'`;
    return Number(row?.active ?? 0) === 0;
  }

  async counts(): Promise<JobCounts> {
    const [row] = await this.prisma.$queryRaw<
      { pending: bigint; retrying: bigint; running: bigint; done: bigint; skipped: bigint }[]
    >`
      SELECT COUNT(*) FILTER (WHERE state = 'PENDING') AS pending,
             COUNT(*) FILTER (WHERE state = 'PENDING' AND attempts > 0) AS retrying,
             COUNT(*) FILTER (WHERE state = 'RUNNING') AS running,
             COUNT(*) FILTER (WHERE state = 'DONE') AS done,
             COUNT(*) FILTER (WHERE state = 'SKIPPED') AS skipped
      FROM track_jobs`;
    return {
      pending: Number(row?.pending ?? 0),
      retrying: Number(row?.retrying ?? 0),
      running: Number(row?.running ?? 0),
      done: Number(row?.done ?? 0),
      skipped: Number(row?.skipped ?? 0),
    };
  }

  /** Jobs in a state, oldest id first, keyset-paged by file id. */
  async list(state: JobSummary['state'], limit: number, cursor?: string): Promise<JobSummary[]> {
    const rows = await this.prisma.trackJob.findMany({
      where: { state, ...(cursor ? { fileId: { gt: cursor } } : {}) },
      orderBy: { fileId: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({
      fileId: r.fileId,
      state: r.state,
      attempts: r.attempts,
      lastError: r.lastError,
      lastErrorStage: r.lastErrorStage,
      skippedAt: r.skippedAt,
      updatedAt: r.updatedAt,
    }));
  }

  /** Most recent failed attempts first. */
  listFailures(limit: number, fileId?: string): Promise<FailureSummary[]> {
    return this.prisma.trackJobFailure.findMany({ where: fileId ? { fileId } : {}, orderBy: { id: 'desc' }, take: limit });
  }

  /** Gives skipped jobs (one, or all) a fresh set of attempts. Returns how many were re-queued. */
  async retrySkipped(fileId?: string): Promise<number> {
    const result = await this.prisma.trackJob.updateMany({
      where: { state: 'SKIPPED', ...(fileId ? { fileId } : {}) },
      data: { state: 'PENDING', attempts: 0, runAfter: new Date(), skippedAt: null, lastError: null, lastErrorStage: null, metadataDone: false, analysisDone: false },
    });
    if (result.count > 0) await this.notify();
    return result.count;
  }

  async pruneFailures(olderThan: Date): Promise<number> {
    return (await this.prisma.trackJobFailure.deleteMany({ where: { at: { lt: olderThan } } })).count;
  }

  notify(): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`SELECT pg_notify(${JOB_CHANNEL}, '')`);
  }
}
