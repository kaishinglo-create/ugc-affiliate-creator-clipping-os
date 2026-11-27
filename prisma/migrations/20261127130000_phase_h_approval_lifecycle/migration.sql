-- Phase H.3: approval expiry and revocation. Existing approvals stay valid
-- until they are explicitly revoked or an expiry is set.
ALTER TABLE "Approval"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "revokedAt" TIMESTAMP(3);

CREATE INDEX "Approval_workspaceId_status_expiresAt_idx"
  ON "Approval"("workspaceId", "status", "expiresAt");
