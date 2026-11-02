# CELL-SECURITY — Security Audit Report (READ ONLY)

## Scope
Workspace authentication, membership checks, transaction/RLS scope, Job hardening, secret handling, control-center/MCP exposure posture, file containment, integration status reconciliation, and relevant security tests. No repairs, deployments, permission widens, or secrets were produced.

## Evidence and checks
Commands / references:
- `git status --short`: working tree is not clean and contains untracked audit artifacts/control centers.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → pass.
- `node node_modules/typescript/bin/tsc -p tsconfig.json && rm -rf dist/src/generated && cp -r src/generated dist/src/generated` → pass.
- `node node_modules/eslint/bin/eslint.js .` → 0 errors, 9 warnings.
- `node node_modules/vitest/vitest.mjs run` → 28 test files / 79 tests pass under temporary non-superuser `ugc_os_app` role.
- `psql`: temporary database `ugc_os_test` used only for isolated verification. User's runtime database was not migrated.
- Read `src/index.ts`, `src/jobs.ts`, `lib/auth.ts`, migrations, existing wave reports.

## Verified findings

### SEC-A01 (Medium) — `Job` now has table-level RLS
Evidence: migration `20261101000000_phase20_job_workspace_rls/migration.sql` enables and forces RLS and defines `Job_workspace_isolation`. Direct PostgreSQL inspection on test database confirms `relrowsecurity=true`, `relforcerowsecurity=true`, and policy presence.

### SEC-A02 (High / residual by design) — Control center is a high-authority local console
- Evidence from existing `.mece-control/server.mjs` reviewed earlier: dashboard binds to `127.0.0.1:3031`, OpenCode binds to `127.0.0.1:4096`; `/api/run` executes OpenCode/automation commands.
- No application authentication layer is visible beyond loopback and origin checks.
- This is acceptable only under strongly isolated localhost use, but any user/process allowed to reach 127.0.0.1 or influence origin-validity rules could invoke operations.

### SEC-A03 (Medium / external environmental) — RLS proof is environment-sensitive
- Evidence: PostgreSQL superusers bypass FORCE RLS. The local superuser `u0_a304` can bypass Job policies. A non-superuser test role is required to verify tenant isolation.
- The `ugc_os_app` temporary database verification passed, including workspace-scoped Job behavior.

### SEC-A04 (Medium) — Optional workspace scope remains a backward-compatible risk
- Helpers support `workspaceId` guards but several signatures still allow omission. Production routes currently forward workspace IDs, but helper consumers can omit them.
- Non-superuser route/test behavior passed with workspace binding, reducing practical cross-tenant risk.

### SEC-A05 (Low) — Historical config/backup secret retention
- `.mece-control/mcp` save behavior can create timestamped `.bak` backups under `.mece-control/runs`; backup notes contain file paths, not secrets, but backups may preserve raw OpenCode config.
- No cleanup/retention policy is clearly visible in source.

### SEC-A06 (Low) — Ollama key is server-side, but metadata advertises only four providers
- Evidence: Ollama credentials are read via `process.env` and never returned in integration APIs. `/api/integrations` does not include Ollama, so backend readiness is less discoverable. This is metadata inconsistency rather than key leakage.

### SEC-A07 (Low) — Unscoped primary-key read fallback exists in `getJob` without workspace
- Evidence: `getJob(jobId, workspaceIdOrOpts = null)` falls back to primary-key `findUnique` when omitted. Under non-superuser RLS this returns no Job rows, which is fail-closed but can hide errors.
- Typical callers are routes that now pass workspace IDs.

### SEC-A08 (Medium) — Local superuser role bypasses isolation protections
- No new source defect found; this is an environmental/verification caveat.
- Findings cannot be fully represented unless tests run under `NOSUPERUSER NOBYPASSRLS`.

### SEC-A09 (Low / informational) — Symlink/path and deep-link risks not re-tested
- Cross-reference from earlier release/security audits: null-byte path protection was added to `serveFile`, but general path allowlist and deep-link fallback behavior were not re-tested in this wave.
- Marked partially verified to avoid overstating.

## Open risks
1. Local MECE operator control center requires a trusted localhost boundary; no dashboard user auth is visible.
2. Secret-bearing `.bak` files may exist from prior control-center use and should be retained/removed only by user decision.
3. RLS test dependence on nonsuperuser environments means local developer runs using superusers can still appear to weaken assertions.
4. Historical `.mece` stale reports remain in repository unless superseded by new wave reports.

## Blockers
- No browser/Playwright evidence; network exposure proof is source-binding only.
- Not deployed/migrated production schema in this audit.
- No repair permitted in this wave.

## Confidence
- Static source and migration evidence: high.
- Non-superuser functional verification: medium-high, synthetic DB and role only.
- Secret exposure proof: limited to behavior, not exhaustive backup inventory; backup values were not inspected.
- Host network exposure: medium (source binds loopback).

## Notes
- Security audit was read-only except for report creation.
- No commits, deployments, secrets, migrations, or database mutations were performed against a user runtime database.
