-- Phase H: workspace-scoped publishing plans/accounts and affiliate links.
-- Credentials are never stored here; publishing secrets stay in the encrypted
-- API Integration Center tables.

ALTER TABLE "AffiliateClick"
  ADD COLUMN "linkId" TEXT,
  ADD COLUMN "postId" TEXT,
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "creatorId" TEXT,
  ADD COLUMN "productId" TEXT,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "utmSource" TEXT,
  ADD COLUMN "utmMedium" TEXT,
  ADD COLUMN "utmCampaign" TEXT,
  ADD COLUMN "utmContent" TEXT,
  ADD COLUMN "utmTerm" TEXT,
  ADD COLUMN "referrer" TEXT,
  ADD COLUMN "externalEventId" TEXT;

ALTER TABLE "QualityReport"
  ADD COLUMN "checksum" TEXT;

ALTER TABLE "AffiliateConversion"
  ADD COLUMN "commissionCents" INTEGER,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "payoutReference" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "externalEventId" TEXT;

CREATE UNIQUE INDEX "AffiliateClick_workspaceId_externalEventId_key"
  ON "AffiliateClick"("workspaceId", "externalEventId");
CREATE INDEX "AffiliateClick_workspaceId_campaignId_idx"
  ON "AffiliateClick"("workspaceId", "campaignId");
CREATE INDEX "AffiliateClick_workspaceId_creatorId_idx"
  ON "AffiliateClick"("workspaceId", "creatorId");
CREATE INDEX "AffiliateClick_workspaceId_platform_idx"
  ON "AffiliateClick"("workspaceId", "platform");
CREATE UNIQUE INDEX "AffiliateConversion_workspaceId_externalEventId_key"
  ON "AffiliateConversion"("workspaceId", "externalEventId");

CREATE TABLE "AffiliateLink" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL,
  "campaignId" TEXT,
  "creatorId" TEXT,
  "productId" TEXT,
  "offerId" TEXT NOT NULL,
  "destinationUrl" TEXT NOT NULL,
  "commissionBps" INTEGER,
  "disclosureText" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AffiliateLink_workspaceId_token_key"
  ON "AffiliateLink"("workspaceId", "token");
CREATE INDEX "AffiliateLink_workspaceId_campaignId_idx"
  ON "AffiliateLink"("workspaceId", "campaignId");
ALTER TABLE "AffiliateLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AffiliateLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY "AffiliateLink_workspace_isolation" ON "AffiliateLink"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "PublishingAccount" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL,
  "accountKey" TEXT NOT NULL,
  "displayName" TEXT,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublishingAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublishingAccount_workspaceId_platform_accountKey_key"
  ON "PublishingAccount"("workspaceId", "platform", "accountKey");
CREATE INDEX "PublishingAccount_workspaceId_platform_idx"
  ON "PublishingAccount"("workspaceId", "platform");
ALTER TABLE "PublishingAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishingAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PublishingAccount_workspace_isolation" ON "PublishingAccount"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

CREATE TABLE "PublishingSchedule" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "platform" TEXT NOT NULL,
  "accountKey" TEXT,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "approvalId" TEXT NOT NULL,
  "qualityReportId" TEXT,
  "checksum" TEXT,
  "options" JSONB,
  "localTime" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "runAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublishingSchedule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PublishingSchedule_workspaceId_idempotencyKey_key"
  ON "PublishingSchedule"("workspaceId", "idempotencyKey");
CREATE INDEX "PublishingSchedule_workspaceId_status_runAt_idx"
  ON "PublishingSchedule"("workspaceId", "status", "runAt");
ALTER TABLE "PublishingSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublishingSchedule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PublishingSchedule_workspace_isolation" ON "PublishingSchedule"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
