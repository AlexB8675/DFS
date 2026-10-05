-- The slowest statements for Admin → Database (DESIGN §16). pg_stat_statements
-- isn't a trusted extension: without the right to create it, the migration
-- goes on, and the page says how to turn it on. It also needs the server
-- started with shared_preload_libraries = 'pg_stat_statements'.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
  RAISE NOTICE 'pg_stat_statements was not created: %', SQLERRM;
END
$$;
