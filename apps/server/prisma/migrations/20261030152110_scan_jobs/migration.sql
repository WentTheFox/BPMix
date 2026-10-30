-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'SKIPPED');

-- CreateTable
CREATE TABLE "track_jobs" (
    "file_id" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "fingerprint" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "lock_expires_at" TIMESTAMP(3),
    "metadata_done" BOOLEAN NOT NULL DEFAULT false,
    "analysis_done" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "last_error_stage" TEXT,
    "skipped_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "track_jobs_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "track_job_failures" (
    "id" SERIAL NOT NULL,
    "file_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "error" TEXT NOT NULL,
    "will_retry" BOOLEAN NOT NULL,
    "worker_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_job_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "track_jobs_state_run_after_idx" ON "track_jobs"("state", "run_after");

-- CreateIndex
CREATE INDEX "track_job_failures_file_id_idx" ON "track_job_failures"("file_id");

-- CreateIndex
CREATE INDEX "track_job_failures_at_idx" ON "track_job_failures"("at");
