ALTER TABLE "share_links" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_version_id_file_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."file_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_links_version_id" ON "share_links" USING btree ("version_id") WHERE "share_links"."version_id" IS NOT NULL;--> statement-breakpoint
-- File links made before this served their file's current version, and keep
-- it from now on (DESIGN §7.5). Journaled as the API journals a link (§8),
-- under the journal's lock, taken after the rows', as every journaled write
-- does (LOCK_NAMESPACE, LOCKS.journal in packages/db/src/locks.ts).
UPDATE "share_links" link SET "version_id" = node."current_version_id"
FROM "nodes" node WHERE node."id" = link."node_id" AND node."kind" = 'file';
--> statement-breakpoint
SELECT pg_advisory_xact_lock(4474451, 3);
--> statement-breakpoint
INSERT INTO "journal" ("kind", "record")
SELECT 'share.upsert', jsonb_build_object(
  'id', link."id",
  'nodeId', link."node_id",
  'versionId', link."version_id",
  'tokenHash', encode(link."token_hash", 'hex'),
  'createdAt', link."created_at",
  'expiresAt', link."expires_at",
  'passwordHash', link."password_hash",
  'passwordVersion', link."password_version",
  'maxDownloads', link."max_downloads",
  'revokedAt', link."revoked_at"
)
FROM "share_links" link JOIN "nodes" node ON node."id" = link."node_id"
WHERE node."kind" = 'file'
ORDER BY link."created_at", link."id";
