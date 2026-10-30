-- CreateTable
CREATE TABLE "lastfm_connections" (
    "user_id" TEXT NOT NULL,
    "username" TEXT,
    "session_key_enc" TEXT,
    "connected_at" TIMESTAMP(3),
    "pending_token" TEXT,
    "pending_at" TIMESTAMP(3),

    CONSTRAINT "lastfm_connections_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "lastfm_connections" ADD CONSTRAINT "lastfm_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
