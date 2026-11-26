-- Phase F: API Integration Center. Workspace-scoped, RLS-protected storage for
-- encrypted credentials, connection state, OAuth state and provider events.

CREATE TABLE "ApiCredential" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "providerKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'API_KEY',
  "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "hint" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiConnection" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "providerKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "credentialId" TEXT REFERENCES "ApiCredential"("id") ON DELETE SET NULL,
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorCategory" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "circuitState" TEXT NOT NULL DEFAULT 'CLOSED',
  "cooldownUntil" TIMESTAMP(3),
  "quota" JSONB,
  "grantedScopes" TEXT[] NOT NULL DEFAULT '{}',
  "tokenExpiresAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiIntegrationEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "providerKey" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "actor" TEXT,
  "outcome" TEXT NOT NULL,
  "errorCode" TEXT,
  "errorCategory" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiIntegrationEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthAuthorization" (
  "id" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL REFERENCES "Workspace"("id") ON DELETE CASCADE,
  "providerKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeChallenge" TEXT,
  "redirectUri" TEXT NOT NULL,
  "scopes" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApiCredential_workspaceId_providerKey_key" ON "ApiCredential"("workspaceId", "providerKey");
CREATE INDEX "ApiCredential_workspaceId_idx" ON "ApiCredential"("workspaceId");

CREATE UNIQUE INDEX "ApiConnection_workspaceId_providerKey_key" ON "ApiConnection"("workspaceId", "providerKey");
CREATE INDEX "ApiConnection_workspaceId_providerKey_idx" ON "ApiConnection"("workspaceId", "providerKey");

CREATE INDEX "ApiIntegrationEvent_workspaceId_providerKey_createdAt_idx" ON "ApiIntegrationEvent"("workspaceId", "providerKey", "createdAt");

CREATE UNIQUE INDEX "OAuthAuthorization_stateHash_key" ON "OAuthAuthorization"("stateHash");
CREATE INDEX "OAuthAuthorization_workspaceId_providerKey_idx" ON "OAuthAuthorization"("workspaceId", "providerKey");

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ApiCredential','ApiConnection','ApiIntegrationEvent','OAuthAuthorization']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_workspace_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING ("workspaceId" = current_workspace_id()) WITH CHECK ("workspaceId" = current_workspace_id())',
      t || '_workspace_isolation', t
    );
  END LOOP;
END $$;
