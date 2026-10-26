ALTER TABLE "Integration" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Integration" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Integration_workspace_isolation" ON "Integration";
CREATE POLICY "Integration_workspace_isolation" ON "Integration"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
