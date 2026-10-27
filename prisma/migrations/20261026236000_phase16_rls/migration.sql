ALTER TABLE "ReleaseCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReleaseCheck" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ReleaseCheck_workspace_isolation" ON "ReleaseCheck";
CREATE POLICY "ReleaseCheck_workspace_isolation" ON "ReleaseCheck"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
