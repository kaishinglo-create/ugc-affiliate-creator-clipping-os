-- Phase 20: Firm hierarchy and agent orchestration

CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentKey" TEXT,
    "allowedTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "maxConcurrency" INTEGER NOT NULL DEFAULT 2,
    "budgetLimit" INTEGER NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Department_workspaceId_key_key" ON "Department"("workspaceId", "key");
CREATE INDEX "Department_workspaceId_idx" ON "Department"("workspaceId");

ALTER TABLE "Department" ADD CONSTRAINT "Department_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Department" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Department" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Department_workspace_isolation" ON "Department";
CREATE POLICY "Department_workspace_isolation" ON "Department"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "OrchestrationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "requestedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "strategy" JSONB,
    "result" JSONB,
    "error" TEXT,
    "budgetUnits" INTEGER NOT NULL DEFAULT 100,
    "spentUnits" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 2,
    "currentStage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrchestrationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrchestrationRun_workspaceId_status_idx" ON "OrchestrationRun"("workspaceId", "status");
CREATE INDEX "OrchestrationRun_workspaceId_createdAt_idx" ON "OrchestrationRun"("workspaceId", "createdAt");
ALTER TABLE "OrchestrationRun" ADD CONSTRAINT "OrchestrationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrchestrationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrchestrationRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "OrchestrationRun_workspace_isolation" ON "OrchestrationRun";
CREATE POLICY "OrchestrationRun_workspace_isolation" ON "OrchestrationRun"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "OrchestrationTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "departmentKey" TEXT NOT NULL,
    "agentType" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT FALSE,
    "approvalId" TEXT,
    "dependsOn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "estimatedUnits" INTEGER NOT NULL DEFAULT 1,
    "actualUnits" INTEGER NOT NULL DEFAULT 0,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrchestrationTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrchestrationTask_workspaceId_idx" ON "OrchestrationTask"("workspaceId");
CREATE INDEX "OrchestrationTask_runId_status_idx" ON "OrchestrationTask"("runId", "status");
CREATE INDEX "OrchestrationTask_parentTaskId_idx" ON "OrchestrationTask"("parentTaskId");

ALTER TABLE "OrchestrationTask" ADD CONSTRAINT "OrchestrationTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrchestrationTask" ADD CONSTRAINT "OrchestrationTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "OrchestrationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrchestrationTask" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrchestrationTask" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "OrchestrationTask_workspace_isolation" ON "OrchestrationTask";
CREATE POLICY "OrchestrationTask_workspace_isolation" ON "OrchestrationTask"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "DelegationRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "runId" TEXT,
    "fromRole" TEXT NOT NULL,
    "toDepartment" TEXT NOT NULL,
    "taskIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DelegationRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DelegationRecord_workspaceId_createdAt_idx" ON "DelegationRecord"("workspaceId", "createdAt");
ALTER TABLE "DelegationRecord" ADD CONSTRAINT "DelegationRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DelegationRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DelegationRecord" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DelegationRecord_workspace_isolation" ON "DelegationRecord";
CREATE POLICY "DelegationRecord_workspace_isolation" ON "DelegationRecord"
  FOR ALL
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
