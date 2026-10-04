CREATE TYPE "public"."blob_kind" AS ENUM('solo', 'pack');--> statement-breakpoint
CREATE TYPE "public"."blob_state" AS ENUM('building', 'staged', 'uploading', 'stored', 'lost', 'deleting', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('data', 'journal', 'backup', 'log');--> statement-breakpoint
CREATE TYPE "public"."node_kind" AS ENUM('folder', 'file');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TYPE "public"."upload_state" AS ENUM('receiving', 'completed');--> statement-breakpoint
CREATE TYPE "public"."version_state" AS ENUM('uploading', 'syncing', 'stored', 'failed', 'purging', 'purged');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid,
	"action" text NOT NULL,
	"node_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "blob_kind" NOT NULL,
	"state" "blob_state" NOT NULL,
	"size_bytes" integer NOT NULL,
	"live_bytes" integer DEFAULT 0 NOT NULL,
	"frame_count" integer DEFAULT 0 NOT NULL,
	"sha256" "bytea",
	"channel_id" uuid,
	"message_id" text,
	"attachment_id" text,
	"cdn_url" text,
	"cdn_url_expires_at" timestamp with time zone,
	"staged_path" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"lost_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"version_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"plain_size" integer NOT NULL,
	"frame_size" integer NOT NULL,
	"plain_sha256" "bytea" NOT NULL,
	"frame_sha256" "bytea" NOT NULL,
	"blob_id" bigint,
	"blob_offset" integer,
	"staged_path" text,
	"purged_at" timestamp with time zone,
	CONSTRAINT "chunks_blob_offset" CHECK (("chunks"."blob_id" IS NULL) = ("chunks"."blob_offset" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "file_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"node_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"state" "version_state" DEFAULT 'uploading' NOT NULL,
	"size_bytes" bigint NOT NULL,
	"chunk_size" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"chunks_stored" integer DEFAULT 0 NOT NULL,
	"content_hash" "bytea",
	"wrapped_dek" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_stat_deltas" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "folder_stat_deltas_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"node_id" uuid NOT NULL,
	"file_delta" integer NOT NULL,
	"byte_delta" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folder_stats" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"file_count" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_no" bigint
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" "node_kind" NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"current_version_id" uuid,
	"mime_type" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"trashed_via" uuid,
	"moderation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_root_is_folder" CHECK ("nodes"."parent_id" IS NOT NULL OR "nodes"."kind" = 'folder')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"node_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"password_hash" text,
	"password_version" integer DEFAULT 0 NOT NULL,
	"max_downloads" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "storage_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"discord_channel_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "channel_kind" DEFAULT 'data' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"blob_count" bigint DEFAULT 0 NOT NULL,
	"bytes_stored" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"state" "upload_state" DEFAULT 'receiving' NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"is_owner" boolean DEFAULT false NOT NULL,
	"role" "role" DEFAULT 'user' NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"root_node_id" uuid,
	"disabled_at" timestamp with time zone,
	"failed_sign_ins" integer DEFAULT 0 NOT NULL,
	"sign_in_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_username_lowercase" CHECK ("users"."username" = lower("users"."username")),
	CONSTRAINT "users_owner_is_admin" CHECK (NOT "users"."is_owner" OR "users"."role" = 'admin')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_channel_id_storage_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_stats" ADD CONSTRAINT "folder_stats_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_current_version_id_file_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."file_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_root_node_id_nodes_id_fk" FOREIGN KEY ("root_node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_id" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "blobs_queue" ON "blobs" USING btree ("state") WHERE "blobs"."state" IN ('staged', 'uploading', 'deleting');--> statement-breakpoint
CREATE INDEX "blobs_channel_id" ON "blobs" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_version_idx" ON "chunks" USING btree ("version_id","idx");--> statement-breakpoint
CREATE INDEX "chunks_blob_id" ON "chunks" USING btree ("blob_id");--> statement-breakpoint
CREATE INDEX "chunks_waiting_for_pack" ON "chunks" USING btree ("id") WHERE "chunks"."blob_id" IS NULL AND "chunks"."purged_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "file_versions_number" ON "file_versions" USING btree ("node_id","version_no");--> statement-breakpoint
CREATE INDEX "file_versions_in_flight" ON "file_versions" USING btree ("state") WHERE "file_versions"."state" IN ('uploading', 'syncing', 'purging');--> statement-breakpoint
CREATE INDEX "journal_unflushed" ON "journal" USING btree ("id") WHERE "journal"."batch_no" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_unique_name" ON "nodes" USING btree ("parent_id","name_key") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_listing" ON "nodes" USING btree ("parent_id","kind","name_key","id") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_one_root_per_owner" ON "nodes" USING btree ("owner_id") WHERE "nodes"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_name_trgm" ON "nodes" USING gin ("name_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "nodes_trash" ON "nodes" USING btree ("owner_id","deleted_at") WHERE "nodes"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "nodes_trashed_via" ON "nodes" USING btree ("trashed_via") WHERE "nodes"."trashed_via" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_node_id" ON "share_links" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_channels_discord_id" ON "storage_channels" USING btree ("discord_channel_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_user_id" ON "upload_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_expires_at" ON "upload_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_owner" ON "users" USING btree ("is_owner") WHERE "users"."is_owner";