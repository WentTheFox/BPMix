-- CreateTable
CREATE TABLE "tracks" (
    "file_id" TEXT NOT NULL,
    "root_id" TEXT NOT NULL,
    "relative_path" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "last_modified_ms" DOUBLE PRECISION NOT NULL,
    "missing" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "playlists" (
    "id" TEXT NOT NULL,
    "root_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "track_file_ids" TEXT[],

    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_metadata" (
    "file_id" TEXT NOT NULL,
    "title" TEXT,
    "artists" TEXT[],
    "album" TEXT,
    "duration_seconds" DOUBLE PRECISION,
    "size_bytes" BIGINT NOT NULL,
    "last_modified_ms" DOUBLE PRECISION NOT NULL,
    "parser_version" INTEGER NOT NULL,
    "content_hash" TEXT,

    CONSTRAINT "track_metadata_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "track_analysis" (
    "file_id" TEXT NOT NULL,
    "normalization_gain" DOUBLE PRECISION NOT NULL,
    "analyzed_at_ms" DOUBLE PRECISION NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "last_modified_ms" DOUBLE PRECISION NOT NULL,
    "algorithm_version" INTEGER NOT NULL,

    CONSTRAINT "track_analysis_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "cover_art" (
    "file_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "cover_art_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "lyrics_scopes" (
    "root_id" TEXT NOT NULL,
    "relative_path" TEXT NOT NULL,

    CONSTRAINT "lyrics_scopes_pkey" PRIMARY KEY ("root_id","relative_path")
);

-- CreateTable
CREATE TABLE "lyrics_assignments" (
    "file_id" TEXT NOT NULL,
    "lrc_file_id" TEXT,

    CONSTRAINT "lyrics_assignments_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "kv" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "kv_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "tracks_root_id_idx" ON "tracks"("root_id");

-- CreateIndex
CREATE INDEX "playlists_root_id_idx" ON "playlists"("root_id");
