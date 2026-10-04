CREATE TABLE "folder_stats_dirty" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
