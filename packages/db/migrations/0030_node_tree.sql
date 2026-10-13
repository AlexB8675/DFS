-- Which tree each node is in (DESIGN.md §7.7): My drive, the Backups drive or
-- the vault. Every node is in My drive until those exist.
CREATE TYPE "public"."node_tree" AS ENUM('drive', 'backups', 'vault');--> statement-breakpoint
DROP INDEX "nodes_one_root_per_owner";--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "tree" "node_tree" DEFAULT 'drive' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_one_root_per_owner" ON "nodes" USING btree ("owner_id","tree") WHERE "nodes"."parent_id" IS NULL;
--> statement-breakpoint
-- A node is in its parent's tree (§7.7): set here, so no insert can forget it.
-- A root keeps the tree it is given.
CREATE FUNCTION nodes_inherit_tree() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    -- coalesce: a recovery inserts every node in one statement, so a parent
    -- may not be visible yet; it recomputes trees afterwards (sub-phase 2).
    NEW.tree := coalesce((SELECT tree FROM nodes WHERE id = NEW.parent_id), NEW.tree);
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER nodes_inherit_tree BEFORE INSERT ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_inherit_tree();
