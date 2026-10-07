-- Share links and the audit log join the journal (DESIGN §8). Those already
-- written go in now, as the API writes them from here on: a link's state
-- without its download count, its token's hash in hex; an entry as written.
-- Migrations run before the API and the bot start, so nothing else journals
-- meanwhile and these take the next IDs in order.
INSERT INTO "journal" ("kind", "record")
SELECT 'share.upsert', jsonb_build_object(
  'id', "id",
  'nodeId', "node_id",
  'tokenHash', encode("token_hash", 'hex'),
  'createdAt', "created_at",
  'expiresAt', "expires_at",
  'passwordHash', "password_hash",
  'passwordVersion', "password_version",
  'maxDownloads', "max_downloads",
  'revokedAt', "revoked_at"
)
FROM "share_links"
ORDER BY "created_at", "id";
--> statement-breakpoint
INSERT INTO "journal" ("kind", "record")
SELECT 'audit.added', jsonb_build_object(
  'id', "id",
  'userId', "user_id",
  'action', "action",
  'nodeId', "node_id",
  'meta', "meta",
  'at', "at"
)
FROM "audit_log"
ORDER BY "id";
