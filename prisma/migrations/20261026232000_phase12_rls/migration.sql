ALTER TABLE "Incident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Incident" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Incident_workspace_isolation" ON "Incident";
CREATE POLICY "Incident_workspace_isolation" ON "Incident"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
