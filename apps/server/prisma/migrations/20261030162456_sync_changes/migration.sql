-- CreateTable
CREATE TABLE "changes" (
    "rev" BIGINT NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changes_pkey" PRIMARY KEY ("rev")
);

-- CreateIndex
CREATE INDEX "changes_entity_key_idx" ON "changes"("entity", "key");

-- CreateIndex
CREATE INDEX "changes_user_id_rev_idx" ON "changes"("user_id", "rev");

-- CreateIndex
CREATE INDEX "changes_at_idx" ON "changes"("at");

-- ---------------------------------------------------------------------------
-- Change capture. Not modelled in schema.prisma (Prisma doesn't manage
-- triggers); the Change model above is the table these write to.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE change_rev_seq;

-- Records "this row changed" for the synced entity named by the first trigger argument. The second
-- argument is the column holding the entity's key; the optional third, the column holding the owning
-- user (omitted for shared library data).
--
-- The advisory lock is the point: it is held until the surrounding transaction commits, so two
-- transactions can't interleave their revisions. Revisions therefore become visible in increasing
-- order, and a reader that has seen rev N can never later have rev M < N appear behind it.
CREATE FUNCTION record_change() RETURNS trigger AS $$
DECLARE
  row_json jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bpmix-change-log'));
  INSERT INTO changes (rev, entity, key, user_id)
  VALUES (
    nextval('change_rev_seq'),
    TG_ARGV[0],
    row_json ->> TG_ARGV[1],
    CASE WHEN TG_NARGS > 2 THEN row_json ->> TG_ARGV[2] ELSE NULL END
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Everything that makes up a track as clients see it (the track row and the rows hanging off it)
-- reports as a change to that track. UPDATE triggers skip no-op rewrites.
CREATE TRIGGER tracks_change_ins AFTER INSERT ON tracks FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER tracks_change_upd AFTER UPDATE ON tracks FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER tracks_change_del AFTER DELETE ON tracks FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');

CREATE TRIGGER track_metadata_change_ins AFTER INSERT ON track_metadata FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER track_metadata_change_upd AFTER UPDATE ON track_metadata FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER track_metadata_change_del AFTER DELETE ON track_metadata FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');

CREATE TRIGGER track_analysis_change_ins AFTER INSERT ON track_analysis FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER track_analysis_change_upd AFTER UPDATE ON track_analysis FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER track_analysis_change_del AFTER DELETE ON track_analysis FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');

CREATE TRIGGER cover_art_change_ins AFTER INSERT ON cover_art FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER cover_art_change_upd AFTER UPDATE ON cover_art FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER cover_art_change_del AFTER DELETE ON cover_art FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');

CREATE TRIGGER lyrics_assignments_change_ins AFTER INSERT ON lyrics_assignments FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER lyrics_assignments_change_upd AFTER UPDATE ON lyrics_assignments FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('track', 'file_id');
CREATE TRIGGER lyrics_assignments_change_del AFTER DELETE ON lyrics_assignments FOR EACH ROW EXECUTE FUNCTION record_change('track', 'file_id');

CREATE TRIGGER playlists_change_ins AFTER INSERT ON playlists FOR EACH ROW EXECUTE FUNCTION record_change('playlist', 'id');
CREATE TRIGGER playlists_change_upd AFTER UPDATE ON playlists FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('playlist', 'id');
CREATE TRIGGER playlists_change_del AFTER DELETE ON playlists FOR EACH ROW EXECUTE FUNCTION record_change('playlist', 'id');
