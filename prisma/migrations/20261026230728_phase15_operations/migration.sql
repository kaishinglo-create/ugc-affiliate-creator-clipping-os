-- CreateTable
CREATE TABLE "OperationalPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentLifecycleEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalPolicy_workspaceId_key_key" ON "OperationalPolicy"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "ContentLifecycleEvent_workspaceId_entityType_entityId_idx" ON "ContentLifecycleEvent"("workspaceId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "OperationalPolicy" ADD CONSTRAINT "OperationalPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentLifecycleEvent" ADD CONSTRAINT "ContentLifecycleEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
