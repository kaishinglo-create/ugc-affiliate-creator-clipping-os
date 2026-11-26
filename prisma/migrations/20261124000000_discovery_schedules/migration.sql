CREATE TABLE "DiscoverySchedule" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "query" TEXT NOT NULL,
  "intervalMinutes" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "nextRunAt" TIMESTAMP(3) NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoverySchedule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DiscoverySchedule_workspaceId_enabled_nextRunAt_idx"
  ON "DiscoverySchedule"("workspaceId", "enabled", "nextRunAt");

ALTER TABLE "DiscoverySchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoverySchedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DiscoverySchedule_workspace_isolation" ON "DiscoverySchedule"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
