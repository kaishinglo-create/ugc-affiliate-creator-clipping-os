# CELL-06 — MCP, Dashboard, and Secret-Management Audit

## Scope
Local MECE control center, OpenCode server proxy, MCP connectors, secrets handling, backups, and project settings.

## Evidence
- Existing source survey of `.mece-control/server.mjs`.
- Control center binds dashboard `127.0.0.1:3031`, OpenCode `127.0.0.1:4096`.
- MCP connector saves only after explicit confirmation; validation for URL, command and metadata shape.
- Responses expose `hasSecrets`, not raw secret values.
- No MCP server configured at prior initial audit baseline; one Ollama-related unverified successful chat request documented.

## Findings

### MCP-01 (MEDIUM) — No dashboard authentication beyond loopback/origin checks
- Cause: route authorization is absent for operator console.
- Scenario: any local caller can potentially invoke `/api/run`, save/delete connectors, or trigger chat if origin rules are satisfied.
- Confidence: Medium.

### MCP-02 (MEDIUM) — Historical `.bak` files can preserve secret-bearing configs
- Cause: pre-write backups are always created when saving MCP.
- Missing retention/size/redaction policy.
- Confidence: Medium.

### MCP-03 (LOW) — Secrets are stored in plaintext OpenCode configuration when configured
- Cause: MCP config entries containing env/header objects are written to OpenCode project/global files.
- App behavior exposes only metadata and redacts in errors, but storage remains OS-level secret risk.
- Confidence: High.

### MCP-04 (LOW / informational) — MCP testing scope is limited to `opencode mcp list`
- Cause: `POST /api/mcp/test` executes status only and may truncate output at 12K.
- No end-to-end tool call verification.
- Confidence: High.

### MCP-05 (LOW) — Chat and automation can trigger paid model usage
- Cause: explicit user action only; not automatic. Billing still outside app budgets.
- Confidence: High.

## Recommendations
- Add authenticated operator sessions and allowlisted project/automation paths.
- Redact and securely expire backup copies.
- Never display existing secret values and add backup cleanup controls.

## Blockers / limits
- No MCP server actually connected during current audit.
- No secret inventory or backup values inspected.
- No signed command definitions for `.opencode` agents/commands.
