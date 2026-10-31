-- CreateTable
CREATE TABLE "lyrics_reports" (
    "id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "relative_path" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lyrics_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lyrics_reports_user_id_file_id_key" ON "lyrics_reports"("user_id", "file_id");

-- AddForeignKey
ALTER TABLE "lyrics_reports" ADD CONSTRAINT "lyrics_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
