ALTER TABLE "folder_stat_deltas" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "folder_stat_deltas" CASCADE;--> statement-breakpoint
DROP INDEX "nodes_listing";--> statement-breakpoint
CREATE INDEX "nodes_listing_by_name" ON "nodes" USING btree ("parent_id","kind","name_key" COLLATE "dfs_natural","id") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_listing_by_updated" ON "nodes" USING btree ("parent_id","kind","updated_at","id") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_listing_by_size" ON "nodes" USING btree ("parent_id","kind","size_bytes","id") WHERE "nodes"."deleted_at" IS NULL;