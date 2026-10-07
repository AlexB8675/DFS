-- A link turned off is deleted now, not kept as revoked (DESIGN §7.5): those
-- turned off before go, journaled as the API journals a deletion (§8), under
-- the journal's lock, as every journaled write takes it (LOCK_NAMESPACE,
-- LOCKS.journal in packages/db/src/locks.ts).
SELECT pg_advisory_xact_lock(4474451, 3);
--> statement-breakpoint
INSERT INTO "journal" ("kind", "record")
SELECT 'share.deleted', jsonb_build_object('id', "id")
FROM "share_links" WHERE "revoked_at" IS NOT NULL
ORDER BY "created_at", "id";
--> statement-breakpoint
DELETE FROM "share_links" WHERE "revoked_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "revoked_at";
