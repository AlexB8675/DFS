-- Natural sort order for names (DESIGN §5.1): "file2" before "file10".
-- Deterministic ICU collation, so B-tree indexes can use it.
CREATE COLLATION IF NOT EXISTS dfs_natural (provider = icu, locale = 'und-u-kn-true');
