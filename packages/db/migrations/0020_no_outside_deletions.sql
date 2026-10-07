-- Only the bot reaches DFS's Discord channels (D31), so nothing deletes a
-- storage message but DFS itself: the `lost` states go, with when a loss was
-- noticed and the index the deletion watch found blobs by. No instance has a
-- lost row (a row still lost would fail the casts below), and old samples of
-- the lost-blob gauge go with the series.
--
-- Postgres can't drop an enum value, so each type is made again. The partial
-- indexes whose condition names the old type go first and are made again last.
DROP INDEX "blobs_lost";--> statement-breakpoint
DROP INDEX "blobs_message_id";--> statement-breakpoint
DROP INDEX "blobs_queue";--> statement-breakpoint
DROP INDEX "file_versions_in_flight";--> statement-breakpoint
ALTER TABLE "blobs" DROP COLUMN "lost_at";--> statement-breakpoint
ALTER TYPE "public"."blob_state" RENAME TO "blob_state_old";--> statement-breakpoint
CREATE TYPE "public"."blob_state" AS ENUM('building', 'staged', 'uploading', 'stored', 'deleting', 'deleted');--> statement-breakpoint
ALTER TABLE "blobs" ALTER COLUMN "state" SET DATA TYPE "public"."blob_state" USING "state"::text::"public"."blob_state";--> statement-breakpoint
DROP TYPE "public"."blob_state_old";--> statement-breakpoint
ALTER TYPE "public"."version_state" RENAME TO "version_state_old";--> statement-breakpoint
CREATE TYPE "public"."version_state" AS ENUM('uploading', 'syncing', 'stored', 'failed', 'purging', 'purged');--> statement-breakpoint
ALTER TABLE "file_versions" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "file_versions" ALTER COLUMN "state" SET DATA TYPE "public"."version_state" USING "state"::text::"public"."version_state";--> statement-breakpoint
ALTER TABLE "file_versions" ALTER COLUMN "state" SET DEFAULT 'uploading';--> statement-breakpoint
DROP TYPE "public"."version_state_old";--> statement-breakpoint
CREATE INDEX "blobs_queue" ON "blobs" USING btree ("state") WHERE "blobs"."state" IN ('staged', 'uploading', 'deleting');--> statement-breakpoint
CREATE INDEX "file_versions_in_flight" ON "file_versions" USING btree ("state") WHERE "file_versions"."state" IN ('uploading', 'syncing', 'purging');--> statement-breakpoint
DELETE FROM "metrics" WHERE "name" = 'blobs.lost';
