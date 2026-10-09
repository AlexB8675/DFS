-- Text subtitles extracted from inside a file (DESIGN §6.7), each sealed with
-- its own data key, or why it couldn't be. Derived, so not journaled; it goes
-- with its version.
CREATE TABLE "media_subtitles" (
	"version_id" uuid NOT NULL,
	"stream_index" integer NOT NULL,
	"sealed" "bytea",
	"problem" text,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_subtitles_pkey" PRIMARY KEY("version_id","stream_index"),
	CONSTRAINT "media_subtitles_found" CHECK (("media_subtitles"."sealed" IS NULL) <> ("media_subtitles"."problem" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "media_subtitles" ADD CONSTRAINT "media_subtitles_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;