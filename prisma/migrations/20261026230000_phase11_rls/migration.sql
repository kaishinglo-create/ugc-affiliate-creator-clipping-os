ALTER TABLE "Approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Approval" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Approval_workspace_isolation" ON "Approval";
CREATE POLICY "Approval_workspace_isolation" ON "Approval"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
