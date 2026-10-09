-- Where each user stopped a video or a long audio file (DESIGN §10.4), for
-- the version they played. Not journaled; it goes with its file, its user
-- and its version.
CREATE TABLE "playback_positions" (
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position_ms" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_positions_pkey" PRIMARY KEY("node_id","user_id"),
	CONSTRAINT "playback_positions_position" CHECK ("playback_positions"."position_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "playback_positions" ADD CONSTRAINT "playback_positions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_positions" ADD CONSTRAINT "playback_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_positions" ADD CONSTRAINT "playback_positions_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playback_positions_version" ON "playback_positions" USING btree ("version_id");