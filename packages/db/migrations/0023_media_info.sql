-- What examining an audio or video version found (DESIGN §6.7): its media
-- info, or why ffmpeg reads nothing in it. Derived, so not journaled; it
-- goes with its version.
CREATE TABLE "media_info" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"info" jsonb,
	"problem" text,
	"examined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_info_found" CHECK (("media_info"."info" IS NULL) <> ("media_info"."problem" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "media_info" ADD CONSTRAINT "media_info_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;