ALTER TABLE "blobs" ALTER COLUMN "live_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "sealed_version_id" uuid;