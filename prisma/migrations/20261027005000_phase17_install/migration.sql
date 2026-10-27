CREATE TABLE "InstallCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_run',
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InstallCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InstallCheck_workspaceId_status_idx" ON "InstallCheck"("workspaceId", "status");
ALTER TABLE "InstallCheck" ADD CONSTRAINT "InstallCheck_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstallCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InstallCheck" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "InstallCheck_workspace_isolation" ON "InstallCheck";
CREATE POLICY "InstallCheck_workspace_isolation" ON "InstallCheck"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
