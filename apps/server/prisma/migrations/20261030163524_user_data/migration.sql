-- CreateTable
CREATE TABLE "user_playlists" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "track_file_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playback_states" (
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playback_states_pkey" PRIMARY KEY ("user_id","device_id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id","key")
);

-- CreateTable
CREATE TABLE "applied_mutations" (
    "op_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applied_mutations_pkey" PRIMARY KEY ("op_id")
);

-- CreateIndex
CREATE INDEX "user_playlists_owner_id_idx" ON "user_playlists"("owner_id");

-- CreateIndex
CREATE INDEX "applied_mutations_applied_at_idx" ON "applied_mutations"("applied_at");

-- AddForeignKey
ALTER TABLE "user_playlists" ADD CONSTRAINT "user_playlists_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_states" ADD CONSTRAINT "playback_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-user rows report to the change log scoped to their owner (third trigger argument), so a
-- user's feed carries their own data and nobody else's.
CREATE TRIGGER user_playlists_change_ins AFTER INSERT ON user_playlists FOR EACH ROW EXECUTE FUNCTION record_change('userPlaylist', 'id', 'owner_id');
CREATE TRIGGER user_playlists_change_upd AFTER UPDATE ON user_playlists FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('userPlaylist', 'id', 'owner_id');
CREATE TRIGGER user_playlists_change_del AFTER DELETE ON user_playlists FOR EACH ROW EXECUTE FUNCTION record_change('userPlaylist', 'id', 'owner_id');

CREATE TRIGGER playback_states_change_ins AFTER INSERT ON playback_states FOR EACH ROW EXECUTE FUNCTION record_change('playbackState', 'device_id', 'user_id');
CREATE TRIGGER playback_states_change_upd AFTER UPDATE ON playback_states FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('playbackState', 'device_id', 'user_id');
CREATE TRIGGER playback_states_change_del AFTER DELETE ON playback_states FOR EACH ROW EXECUTE FUNCTION record_change('playbackState', 'device_id', 'user_id');

CREATE TRIGGER user_settings_change_ins AFTER INSERT ON user_settings FOR EACH ROW EXECUTE FUNCTION record_change('setting', 'key', 'user_id');
CREATE TRIGGER user_settings_change_upd AFTER UPDATE ON user_settings FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION record_change('setting', 'key', 'user_id');
CREATE TRIGGER user_settings_change_del AFTER DELETE ON user_settings FOR EACH ROW EXECUTE FUNCTION record_change('setting', 'key', 'user_id');
