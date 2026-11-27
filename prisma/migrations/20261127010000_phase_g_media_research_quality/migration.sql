-- Phase G: workspace-scoped media sources, research reports and quality reports.

CREATE TABLE "MediaSource" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL DEFAULT 'UPLOAD',
  "name" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "storagePath" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "rightsStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "licenseNote" TEXT,
  "ffprobeJson" JSONB,
  "status" TEXT NOT NULL DEFAULT 'READY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MediaSource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MediaSource_workspaceId_sha256_idx" ON "MediaSource"("workspaceId", "sha256");
CREATE INDEX "MediaSource_workspaceId_rightsStatus_idx" ON "MediaSource"("workspaceId", "rightsStatus");
ALTER TABLE "MediaSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaSource" FORCE ROW LEVEL SECURITY;
CREATE POLICY "MediaSource_workspace_isolation" ON "MediaSource"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "ResearchReport" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "candidateId" TEXT,
  "title" TEXT NOT NULL,
  "overall" DOUBLE PRECISION,
  "scoreJson" JSONB NOT NULL,
  "origin" TEXT NOT NULL DEFAULT 'heuristic',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchReport_workspaceId_candidateId_idx" ON "ResearchReport"("workspaceId", "candidateId");
ALTER TABLE "ResearchReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResearchReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ResearchReport_workspace_isolation" ON "ResearchReport"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "QualityReport" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "jobId" TEXT,
  "clipPath" TEXT NOT NULL,
  "passed" BOOLEAN NOT NULL DEFAULT false,
  "checksJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QualityReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QualityReport_workspaceId_jobId_idx" ON "QualityReport"("workspaceId", "jobId");
ALTER TABLE "QualityReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QualityReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY "QualityReport_workspace_isolation" ON "QualityReport"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
