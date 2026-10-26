CREATE OR REPLACE FUNCTION current_workspace_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_workspace_id', true), '')
$$;

ALTER TABLE "Item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Item" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Item_workspace_isolation" ON "Item";
CREATE POLICY "Item_workspace_isolation" ON "Item"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
