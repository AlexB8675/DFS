-- A released blob's message is deleted only once every journal record
-- written by its release is on Discord (DESIGN §6.4), so `released_at` says
-- when that was. Blobs waiting now count as released now: their message
-- waits for the journal as it is.
ALTER TABLE "blobs" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
UPDATE "blobs" SET "released_at" = now() WHERE "state" = 'deleting';--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_released" CHECK ("blobs"."state" <> 'deleting' OR "blobs"."released_at" IS NOT NULL);
