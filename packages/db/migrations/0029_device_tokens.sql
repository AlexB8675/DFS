-- Device tokens and pairings (DESIGN.md §7.6): a computer's backup app pairs
-- through the browser and signs in with a token found by its SHA-256. Neither
-- table is journaled: after a recovery, devices pair again.
CREATE TABLE "device_pairings" (
	"code_hash" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_address" text,
	"last_agent" text
);
--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairings_user_id" ON "device_pairings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_pairings_expires_at" ON "device_pairings" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_tokens_token_hash" ON "device_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "device_tokens_user_id" ON "device_tokens" USING btree ("user_id");