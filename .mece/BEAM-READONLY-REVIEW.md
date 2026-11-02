# BEAM READ-ONLY REVIEW

Audit ID follow-up: DEEP-AUDIT-2026-10-31 → Beam/agent model review
Date context: Sat Oct 31 2026

## 1. Read-only scope
Only source, configuration, reports, and public tool listings were inspected. No repairs, productive code edits, migration execution, deployments, stashes, cleanups, or cost-bearing model requests were started. Existing untracked changes remain untouched.

## 2. Source report currency
Reviewed all deep-audit artifacts:
- `.mece/deep-audit-2026-10-31/FINDINGS.md`
- `.mece/deep-audit-2026-10-31/REPAIR-PLAN.md`
- `.mece/deep-audit-2026-10-31/TEST-RESULTS.md`
- `.mece/deep-audit-2026-10-31/SUMMARY.md`
- `.mece/deep-audit-2026-10-31/cells/CELL-01` to `CELL-08/REPORT.md`

Finding status after re-inspection:
- DA-C03-API-01 (Ollama upstream 402): still current and externally blocked.
- DA-C01-SEC-01 (control-center authority): still current; source binding inspected but no authenticated operator layer visible.
- DA-C02-DB-01..DB-05: still current; RLS and helper-scope tradeoffs remain accurate.
- DA-C03/API-02..07: still current; no new integration registry entry has been added.
- DA-C04/FE-01..06: still current; no browser E2E instrumentation exists.
- DA-C05/JOB-01..05: still current.
- DA-C06/MCP-01..05: still current.
- DA-C07/DEP-1..DEP-5: still current.
- DA-C08/REG-1..REG-4: still current.

No deep-audit finding was verified as stale by directly re-reading the agent-related config and code. The prior Wave 04 reports remain consistent with their own scope, but historical wording should be superseded by this review for model/provider claims.

## 3. Inventory of actual model configuration

### 3.1 Verified assets
- OpenCode CLI version: `1.19.5`.
- Available provider model `ollama-cloud/beam`: confirmed by `opencode models`.
- Agent definitions under `.opencode/agents/*.md` (`orchestrator`, `frontend-auditor`, `api-auditor`, `security-auditor`, `repair-agent`, `regression-agent`, `synthesis-agent`) do not retain a `model:` property in their current frontmatter.
- `opencode debug config` for agents and subagents shows `options: {}` and no model field; `agent list` also displayed no model field per agent.
- Global OpenCode `~/.config/opencode/opencode.jsonc` contains only schema metadata.
- Project agents are loaded from `.opencode`, but that directory does not contain a model-setting file.
- `.mece-control/server.mjs` has `DEFAULT_MODEL = "ollama-cloud/beam"` and the dashboard control center uses this explicit default.
- Prior `.mece-control/REPORT*.md` records `ollama-cloud/beam` as normal agent/default model.

### 3.2 Configured vs. proven model calls
- Configured association (dashboard/control-center default): orchestrator, repair-agent and subagents can be launched with `--model ollama-cloud/beam`.
- Actual generated OpenCode process model field could not be proven from configuration alone because:
  - agent frontmatter has no `model:`
  - global OpenCode config has no model value
  - `opencode debug config` does not report a selected model.
- Therefore each agent's effective default is `not deterministically pinned in inspected configuration` unless explicitly passed on CLI.
- `ollama-cloud/beam` has been reported once as producing an Assistant response (`OK`) through the control-center bridge in `.mece-control/REPORT-MCP-CHAT.md`; this is historical evidence of one successful call, not proof that every listed agent currently defaults to that model.

Important:
- No model was guessed.
- No additional paid model call was executed in this follow-up.
- `opencode models` is cost-free and only lists available models; a runtime functional test would be a billed model request and requires approval.

## 4. Agent permission inventory (current)
From `opencode debug config` and agent frontmatter:
- orchestrator: mode `primary`, permissions edit `allow`, bash `allow`, task `allow`.
- frontend-auditor: mode `subagent`, edit `deny`, bash `allow`.
- api-auditor: mode `subagent`, edit `deny`, bash `allow`.
- security-auditor: mode `subagent`, edit `deny`, bash `allow`.
- repair-agent: mode `subagent`, edit `allow`, bash `allow`.
- regression-agent: mode `subagent`, edit `deny`, bash `allow`.
- synthesis-agent: mode `subagent`, edit `allow`, bash `allow`.

Additional subagent `build` exists via CLI and has broad allow permissions, but it is not part of the seven required MECE roles.
Command templates (`mece-audit`, `mece-repair`, `mece-regression`, `mece-wave`) explicitly assign `agent: orchestrator`; `mece-wave` explicitly passes `--model model`.

## 5. Specific security verification priorities

### 5.1 Control-center authentication
Status: Medium-High risk, verified structural issue.
- Dashboard HTTP bound `127.0.0.1:3031`.
- OpenCode HTTP bound `127.0.0.1:4096`.
- Automations only run on explicit request.
- Risk remains when host isolation is weakened; no per-user operator authentication layer.
- No repair performed.

### 5.2 Workspace scope of Job helpers
Status: Medium design weakness.
- Route calls now forward `ctx.workspaceId` after recent hardening.
- Optional `workspaceId` fields remain valid by signatures.
- Non-superuser suite passes, including cross-workspace negative cases in scoped test files.
- Recommendation is mandatory signature boundary, not a standalone repair.

### 5.3 Ollama budget / audit
Status: Medium product risk.
- Authorized workspace only.
- Coarse IP rate limiting only.
- Hardcoded model and fixed URL present.
- No budget attribution, kill-switch, or audit events for spend.
- Upstream 402 remains external blocker.

### 5.4 Job RLS and migration
Status: Medium-high source quality; runtime migration gate depends on DB role.
- New migration exists but deployment against production was intentionally not run.
- Temporary non-superuser database proved policy row and isolation behavior.
- CI must retain non-superuser DB role and repeat this proof.

### 5.5 Browser/e2e coverage
Status: Medium evidence gap.
- Six frontend smoke checks passed at prior baseline.
- No browser automation or interactive/responsive proof.
- No write repairs.

### 5.6 Stale MECE configuration
Status: Low-medium.
- Existing reports and cell numbering preserved from prior waves.
- Agent and backup artifacts carry historical titles and counts, including old warning counts corrected in later docs.
- No uncommitted repair changes should be lost (git status is not clean).

## 6. Prioritized repair plan (outline, approvals required)

### R1 — Critical / commercial (HIGH model ask):
1. Fund Ollama Cloud or add/reconcile independently verified provider.
2. Embed Ollama-specific provider status into integration registry where appropriate (`src/integrations.ts`).
3. Add successful model response extraction test (currently unverified).

### R2 — Security/operations:
1. Add stricter operator authentication / localhost    access policy for control center.
2. Ensure secrets in `.bak` historical files are handled, retained minimally, or cleaned on operator review.
3. Maintain and document path/automation allowlists.

### R3 — Tenant boundaries (MEDIUM):
1. Make workspace IDs required in helper signatures where caller should know tenant boundary.
2. Keep all row-level reads transactional and scoped.
3. Explicitly document the allowed compatibility exceptions and why they remain.

### R4 — API boundary controls:
1. Harden body parsing for Ollama/integration endpoints with schema validation.
2. Review and define `trustProxy`, IP extraction.
3. Add budget controls and audited spend events.

### R5 — Test evidence:
1. Add browser/E2E tests for forms/responsive/authorization behavior.
2. Add explicit job lease concurrency contract tests under non-super DB role.
3. Keep non-super database evidence in CI.

## 7. Explicit approval points before any changes
1. Whether to execute any repair wave at all.
2. Whether to use `ollama-cloud/beam` as pinned default or add model config metadata so effective model is unambiguous.
3. Whether to allow any direct harmless functional test that incurs cost.
4. What external integration / provider credit budget to allow.
5. Whether control-center should get authentication middleware or stricter local-only policy.
6. Whether RLS migration should be deployed to production database.
7. Whether workspace helper signature changes (breaking compatibility) are permitted.
8. Whether security scan/dependency audit may contact the internet.
9. Whether historical backup files should be archived or removed.
10. Whether current git diffs should be committed by the user (commit is not permitted by this workflow without user request).

## 8. Consolidated status
- Verified by static/config inspection: model available; agent definitions/config do not deterministically pin model.
- Verified by prior runtime reports: API behavior, timeout 504, 402 preserve, workspace Job RLS policy and behavior.
- Partially verified: control-center robustness, Ollama spend controls, browser responsiveness.
- Blocked: paid live Ollama success, broader hostile testing, internet dependency audit, production migration.
- No repairs or productive writes were made during this follow-up.
