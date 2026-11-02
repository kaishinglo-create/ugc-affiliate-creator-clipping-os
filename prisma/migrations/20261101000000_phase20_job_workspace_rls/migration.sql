-- Phase: Job workspace isolation hardening (RLS)

ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Job" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Job_workspace_isolation" ON "Job";
CREATE POLICY "Job_workspace_isolation" ON "Job"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
