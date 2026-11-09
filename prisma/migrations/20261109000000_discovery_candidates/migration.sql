ALTER TYPE "JobType" ADD VALUE 'CONTENT_DISCOVERY';

CREATE TABLE "DiscoveryCandidate" (
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "source" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "channel" TEXT,
  "firstFoundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscoveryCandidate_pkey" PRIMARY KEY ("workspaceId", "source", "externalId")
);

CREATE INDEX "DiscoveryCandidate_workspaceId_firstFoundAt_idx"
  ON "DiscoveryCandidate"("workspaceId", "firstFoundAt");

ALTER TABLE "DiscoveryCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoveryCandidate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DiscoveryCandidate_workspace_isolation" ON "DiscoveryCandidate"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
