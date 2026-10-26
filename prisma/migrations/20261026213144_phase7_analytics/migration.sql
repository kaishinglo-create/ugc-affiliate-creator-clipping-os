-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateClick" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contentId" TEXT,
    "offerId" TEXT,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,

    CONSTRAINT "AffiliateClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateConversion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clickId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "convertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,

    CONSTRAINT "AffiliateConversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_workspaceId_metric_idx" ON "AnalyticsSnapshot"("workspaceId", "metric");

-- CreateIndex
CREATE INDEX "AffiliateClick_workspaceId_idx" ON "AffiliateClick"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateClick_workspaceId_idempotencyKey_key" ON "AffiliateClick"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AffiliateConversion_workspaceId_idx" ON "AffiliateConversion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateConversion_workspaceId_idempotencyKey_key" ON "AffiliateConversion"("workspaceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateClick" ADD CONSTRAINT "AffiliateClick_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateConversion" ADD CONSTRAINT "AffiliateConversion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
