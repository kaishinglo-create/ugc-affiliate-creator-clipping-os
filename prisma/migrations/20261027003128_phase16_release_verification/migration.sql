-- CreateTable
CREATE TABLE "ReleaseCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_run',
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReleaseCheck_workspaceId_status_idx" ON "ReleaseCheck"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "ReleaseCheck" ADD CONSTRAINT "ReleaseCheck_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
