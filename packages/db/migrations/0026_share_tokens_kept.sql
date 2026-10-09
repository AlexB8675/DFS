-- A share link's token, kept sealed under a data key of its own, so its owner
-- can copy the link again (DESIGN §7.5). Links made before stay without one.
ALTER TABLE "share_links" ADD COLUMN "token_sealed" "bytea";
