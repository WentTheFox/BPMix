/*
  Warnings:

  - You are about to drop the column `for_user_id` on the `invites` table. All the data in the column will be lost.
  - You are about to drop the column `label` on the `invites` table. All the data in the column will be lost.
  - You are about to drop the column `role` on the `invites` table. All the data in the column will be lost.
  - Added the required column `user_id` to the `invites` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "invites" DROP COLUMN "for_user_id",
DROP COLUMN "label",
DROP COLUMN "role",
ADD COLUMN     "user_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "invites_user_id_idx" ON "invites"("user_id");

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
