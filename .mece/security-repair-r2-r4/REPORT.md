# Security Repair R2–R4 Report

## Acceptance summary
R2 (Control-Center hardening), R3 (mandatory Job workspace boundary), and R4 (API/Ollama budget/audit/kill switch), plus durable Beam model config, were executed through bounded, read/write repair changes.

## 1. Source state before changes
- Git branch main was not clean at start (12 tracked modifications and several untracked artifact directories; these were preserved).
- No commits, deployments, productive migration, or stashes performed.

## 2. Model configuration
- All required agent definitions now explicitly configure `model: ollama-cloud/beam`.
- `opencode debug config` passes and verifies each agent.
- No model behavior call was run because it would be paid provider traffic.

## 3. R2 changes
- `.mece-control/server.mjs`: all `/api/` routes now require origin validation and dashboard token authentication.
- Missing/invalid token causes fail-closed 401.
- Token compare uses `crypto.timingSafeEqual`.
- Historical backups were not deleted; secret-path discussion is documented.

## 4. R3 changes
- Job option types now require `workspaceId` where workspace context is an access boundary.
- `getJob` and `claimJobById` require their scope identifiers.
- `failJob` accepts workspace from input or third opts and rejects absent or invalid scope.
- Missing/unresolved scope returns null after implementation.
- Existing budget-and-workspace routes forward IDs.

## 5. R4 changes
- Added deterministic `trustProxy` configuration based only upon `TRUST_PROXY`.
- Added workspace daily request limit with advisory lock for transactional concurrency.
- Added kill-switch check before Ollama.
- Added audit event writes for each request, error class, prompt length, and provider-metadata absence.
- Added budget exceeded response and error body cleanup.
- Added strict simple body allowlist (`prompt`/`message`).

## 6. Repair cells
- `cells/CELL-BEAM/REPORT.md`
- `cells/CELL-R2/REPORT.md`
- `cells/CELL-R3/REPORT.md`
- `cells/CELL-R4/REPORT.md`
- `cells/CELL-REGRESSION/REPORT.md`

## 7. Verification
- Typecheck: passed
- ESLint: passed; warnings 9 only.
- Build: passed.
- Full test suite: 28 files / 79 tests passed under temporary non-superuser database.
- Control center syntax: passed.

## 8. Open risks and dependencies
- Ollama live success remains blocked by upstream 402.
- Control center requires externally supplied `MECE_DASHBOARD_TOKEN`.
- New environment variables `TRUST_PROXY`, `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE` need documentation.
- Historical `.bak` artifacts remain until operator cleanup.
- Browser/E2E evidence still absent.
- All changes remain uncommitted.

## 9. Commit policy
- No commits or deployments performed.
- User decision required to commit/rollback/push.
EOF