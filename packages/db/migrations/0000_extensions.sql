-- Trigram search on names (DESIGN §5.1). pg_trgm is a trusted extension, so
-- the database owner can create it without being a superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
