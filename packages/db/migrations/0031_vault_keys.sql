-- The vault's columns (DESIGN.md §7.7): its root, its salt and the two wraps
-- of its key on the account, with the count of wrong codes and when a reset
-- empties it; on a session, its key sealed while open there, and when it locks.
ALTER TABLE "sessions" ADD COLUMN "vault_key_sealed" "bytea";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "vault_locks_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vault_root_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vault_salt" "bytea";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vault_key_by_code" "bytea";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vault_key_by_recovery" "bytea";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_vault_unlocks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vault_unlock_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "vault_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_vault_root_id_nodes_id_fk" FOREIGN KEY ("vault_root_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_vault_keys_together" CHECK (num_nonnulls("users"."vault_salt", "users"."vault_key_by_code", "users"."vault_key_by_recovery") IN (0, 3));