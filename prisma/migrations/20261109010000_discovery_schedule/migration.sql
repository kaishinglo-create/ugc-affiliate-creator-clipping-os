CREATE TABLE "DiscoverySchedule" (
  "workspaceId" TEXT PRIMARY KEY REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "query" TEXT NOT NULL,
  "intervalMinutes" INTEGER NOT NULL CHECK ("intervalMinutes" BETWEEN 180 AND 10080),
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "nextRunAt" TIMESTAMP(3) NOT NULL
);

ALTER TABLE "DiscoverySchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoverySchedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DiscoverySchedule_workspace_isolation" ON "DiscoverySchedule"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
