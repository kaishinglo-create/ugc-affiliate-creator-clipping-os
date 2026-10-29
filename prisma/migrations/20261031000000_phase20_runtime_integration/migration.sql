-- Phase 20.2: orchestration idempotency, job integration and state hardening.

ALTER TABLE "OrchestrationRun"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "requestHash" TEXT;

CREATE UNIQUE INDEX "OrchestrationRun_workspaceId_idempotencyKey_key" ON "OrchestrationRun"("workspaceId", "idempotencyKey");

ALTER TABLE "OrchestrationTask"
ADD COLUMN "jobId" TEXT;

CREATE INDEX "OrchestrationTask_jobId_idx" ON "OrchestrationTask"("jobId");
ALTER TABLE "OrchestrationTask"
ADD CONSTRAINT "OrchestrationTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
