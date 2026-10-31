-- CreateTable
CREATE TABLE "embedded_lyrics" (
    "file_id" TEXT NOT NULL,
    "text" TEXT,
    "size_bytes" BIGINT NOT NULL,
    "last_modified_ms" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "embedded_lyrics_pkey" PRIMARY KEY ("file_id")
);

-- Sync: a change here changes the track's hasLyrics, so it is recorded like the other per-track tables.
CREATE TRIGGER embedded_lyrics_change_ins AFTER INSERT ON embedded_lyrics FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER embedded_lyrics_change_upd AFTER UPDATE ON embedded_lyrics FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER embedded_lyrics_change_del AFTER DELETE ON embedded_lyrics FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
