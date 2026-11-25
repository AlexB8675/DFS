-- App tokens (DESIGN.md §7.8): an app reaches one folder of My drive with a
-- token found by its SHA-256. Not journaled: after a recovery, apps get new
-- tokens.
CREATE TABLE "app_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"folder_id" uuid NOT NULL,
	"can_write" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_address" text,
	"last_agent" text
);
--> statement-breakpoint
ALTER TABLE "app_tokens" ADD CONSTRAINT "app_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tokens" ADD CONSTRAINT "app_tokens_folder_id_nodes_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_tokens_token_hash" ON "app_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "app_tokens_user_id" ON "app_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_tokens_folder_id" ON "app_tokens" USING btree ("folder_id");