-- Phase I: extend the existing Phase-12 Incident model with persistent
-- fingerprint/evidence/diagnosis fields and add recovery/improvement/sandbox
-- tables. Never drops or replaces the pre-existing Incident rows.

ALTER TABLE "Incident"
  ADD COLUMN "fingerprint" TEXT,
  ADD COLUMN "kind" TEXT,
  ADD COLUMN "evidence" JSONB,
  ADD COLUMN "diagnosis" JSONB,
  ADD COLUMN "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "Incident_open_fingerprint" ON "Incident"("workspaceId", "fingerprint") WHERE "status" = 'open' AND "fingerprint" IS NOT NULL;
CREATE INDEX "Incident_workspaceId_status_detectedAt_idx" ON "Incident"("workspaceId", "status", "detectedAt");
CREATE INDEX "Incident_workspaceId_kind_idx" ON "Incident"("workspaceId", "kind");

CREATE TABLE "RecoveryRun" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "incidentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "plan" JSONB NOT NULL,
  "approvalId" TEXT,
  "result" JSONB,
  "rollback" JSONB,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecoveryRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecoveryRun_workspaceId_incidentId_idx" ON "RecoveryRun"("workspaceId", "incidentId");
CREATE INDEX "RecoveryRun_workspaceId_status_idx" ON "RecoveryRun"("workspaceId", "status");
ALTER TABLE "RecoveryRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RecoveryRun_workspace_isolation" ON "RecoveryRun"
  USING ("workspaceId" = current_workspace_id()) WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "ImprovementTask" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "incidentId" TEXT,
  "title" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "priorityScore" INTEGER NOT NULL DEFAULT 0,
  "risk" TEXT NOT NULL DEFAULT 'low',
  "effort" TEXT NOT NULL DEFAULT 'small',
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "beforeJson" JSONB,
  "afterJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImprovementTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImprovementTask_workspaceId_status_priorityScore_idx" ON "ImprovementTask"("workspaceId", "status", "priorityScore");
ALTER TABLE "ImprovementTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImprovementTask" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ImprovementTask_workspace_isolation" ON "ImprovementTask"
  USING ("workspaceId" = current_workspace_id()) WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "SandboxRun" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "worktreePath" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'created',
  "patchJson" JSONB,
  "reviewJson" JSONB,
  "testsJson" JSONB,
  "approvedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SandboxRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SandboxRun_workspaceId_status_idx" ON "SandboxRun"("workspaceId", "status");
ALTER TABLE "SandboxRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SandboxRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SandboxRun_workspace_isolation" ON "SandboxRun"
  USING ("workspaceId" = current_workspace_id()) WITH CHECK ("workspaceId" = current_workspace_id());
