-- Play timelines and stream sessions (DESIGN.md §16): what the page, the engine
-- and the server saw of a video play, as batches of events. Diagnostics, so
-- neither table is journaled: timelines are kept 28 days, 2 GiB at most.
CREATE TYPE "public"."timeline_kind" AS ENUM('play', 'stream');--> statement-breakpoint
CREATE TYPE "public"."timeline_via" AS ENUM('drive', 'link', 'stream');--> statement-breakpoint
CREATE TABLE "timeline_batches" (
	"timeline_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_ms" integer,
	"address" text NOT NULL,
	"events" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	CONSTRAINT "timeline_batches_pkey" PRIMARY KEY("timeline_id","seq")
);
--> statement-breakpoint
CREATE TABLE "timelines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" timeline_kind NOT NULL,
	"play_id" uuid,
	"via" timeline_via NOT NULL,
	"node_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid,
	"share_id" uuid,
	"address" text NOT NULL,
	"user_agent" text,
	"client_started_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"batches" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeline_batches" ADD CONSTRAINT "timeline_batches_timeline_id_timelines_id_fk" FOREIGN KEY ("timeline_id") REFERENCES "public"."timelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timelines_started_at" ON "timelines" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "timelines_updated_at" ON "timelines" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "timelines_play_id" ON "timelines" USING btree ("play_id") WHERE "timelines"."play_id" IS NOT NULL;