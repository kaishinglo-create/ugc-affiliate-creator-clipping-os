-- Persist orchestration ownership across processes and restarts.
-- leaseEpoch increases on every successful takeover and fences stale workers.
ALTER TABLE "OrchestrationRun"
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "leaseEpoch" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "OrchestrationRun_leaseToken_key" ON "OrchestrationRun"("leaseToken");
CREATE INDEX "OrchestrationRun_workspaceId_leaseExpiresAt_idx" ON "OrchestrationRun"("workspaceId", "leaseExpiresAt");
