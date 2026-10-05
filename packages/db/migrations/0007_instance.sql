CREATE TABLE "instance" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_channels" ADD COLUMN "reconciled_through" text;--> statement-breakpoint
-- This database's name for itself (DESIGN.md §4): 12 random hex digits.
INSERT INTO "instance" ("id") VALUES (left(replace(gen_random_uuid()::text, '-', ''), 12));
