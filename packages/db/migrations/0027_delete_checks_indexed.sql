-- Deleting a node or a version makes Postgres check what refers to it. Without
-- these, each check read all of nodes or upload_sessions, so purging many files
-- took time growing with the drive for every file. nodes_current_version_id
-- also finds the files a stored blob finished.
CREATE INDEX "nodes_parent_id" ON "nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "nodes_current_version_id" ON "nodes" USING btree ("current_version_id") WHERE "nodes"."current_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "upload_sessions_node_id" ON "upload_sessions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_version_id" ON "upload_sessions" USING btree ("version_id");