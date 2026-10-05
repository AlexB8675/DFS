ALTER TYPE "public"."version_state" ADD VALUE 'lost';--> statement-breakpoint
CREATE INDEX "blobs_message_id" ON "blobs" USING btree ("message_id") WHERE "blobs"."message_id" IS NOT NULL;