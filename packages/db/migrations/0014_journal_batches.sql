CREATE TYPE "public"."journal_batch_state" AS ENUM('staged', 'stored');--> statement-breakpoint
CREATE TABLE "journal_batches" (
	"batch_no" bigint PRIMARY KEY NOT NULL,
	"first_id" bigint NOT NULL,
	"last_id" bigint NOT NULL,
	"record_count" integer NOT NULL,
	"state" "journal_batch_state" DEFAULT 'staged' NOT NULL,
	"sealed" "bytea",
	"size_bytes" integer NOT NULL,
	"sha256" "bytea" NOT NULL,
	"channel_id" uuid,
	"message_id" text,
	"attachment_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_channel_id_storage_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."storage_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_batches_staged" ON "journal_batches" USING btree ("batch_no") WHERE "journal_batches"."state" = 'staged';