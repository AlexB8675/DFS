-- Staging reservations and turns (DESIGN.md §6.1, D38): a stream reserves
-- room for what it has yet to send before it sends it, and the oldest one
-- waiting goes first. Kept on the session so every API instance counts them.
ALTER TABLE "upload_sessions" ADD COLUMN "staging_reserved_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "staging_reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "staging_waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "staging_waiting_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "staging_wanted_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "upload_sessions_staging_reserved" ON "upload_sessions" USING btree ("staging_reserved_at") WHERE "upload_sessions"."staging_reserved_bytes" > 0;--> statement-breakpoint
CREATE INDEX "upload_sessions_staging_waiting" ON "upload_sessions" USING btree ("staging_waiting_since") WHERE "upload_sessions"."staging_waiting_since" IS NOT NULL;