# CELL-04 — Independent Regression and Evidence Review

## Scope
Read-only independent review of MECE Wave 04 report consistency, prior wave claims, repository status, and verification gaps. Inspected `.mece/SYNTHESIS.md`, `.mece/WAVE.md`, all four `CELL-0x/REPORT.md` files in their current state, `src/*`, current git status/diff summaries, and recent safe checks. No reports except this one were changed by this cell (CELL reports above were updated separately only in their own files).

## Acknowledgement of uncommitted changes
The working tree is not clean. Modified files are `.env.example`, `AGENTS.md`, `eslint.config.js`, `lib/auth.ts`, `public/app.js`, `src/index.ts`, `src/jobs.ts`, `src/orchestration.ts`. Untracked files include `.mece-control/`, `.mece/`, `.opencode/`, `.run/`, scripts, source additions, and tests. These user changes were preserved. No stash/reset/commit/cleanup was performed. This audit treats the working tree as the code under review.

## Commands and checks used (safe/read-only)
- `git status --short`, `git status`, `git log --oneline -15`, `git diff --stat`.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
- `node node_modules/eslint/bin/eslint.js .` → 0 errors, 9 warnings.
- Production build command → exit 0, generated Prisma client copied.
- `node node_modules/vitest/vitest.mjs run tests/health.test.ts tests/frontend-smoke.test.ts` → 2 files, 7/7 tests passed.
- `curl` not re-run due read-only scope, but prior reports documented unauthenticated 401 and security headers.
- Database-mutating and integration tests were intentionally not executed (Wave 04 rules plus read-only requirement). No test database mutations were made.

## Files/reports reviewed
- `.mece/SYNTHESIS.md` (Wave 03 synthesis)
- `.mece/WAVE.md` (Wave 04 task file)
- `.mece/cells/CELL-01/TASK.md`/`REPORT.md`
- `.mece/cells/CELL-02/TASK.md`/`REPORT.md`
- `.mece/cells/CELL-03/TASK.md`/`REPORT.md`
- `.mece/cells/CELL-04/TASK.md` (this task)
- Current modified/untracked source: `src/index.ts`, `src/jobs.ts`, `src/ollama.ts`, `src/orchestration.ts`, `src/config.ts?`, `lib/auth.ts`, `public/app.js`, tests.

## Verified facts

### 1. Test-count and command consistency
- The synthesis and old reports cite 25/26 test files and 65/66 tests passing with the single `tests/workspace-isolation.test.ts` RLS failure. This was not rerun in this cell to comply with the database-mutation restriction. It is plausible and internally consistent with prior evidence, but it is not independently reverified now.
- Safe checks from this wave differ in warning count: lint now reports 9 warnings, not 8. The discrepancy is caused by `tests/jobs-workspace-scope.test.ts`, an untracked test file added in the uncommitted changes. The clean claim of 8 warnings is therefore stale.
- No current test result claims a successful Ollama model response. The only recorded live Ollama attempt returned 402. This remains an external billing blocker.
- The `tests/jobs-workspace-scope.test.ts` mock test now exists and may alter the test count by +1 file/+ tests, but it was not executed here due scope. Prior reports do not account for it.

### 2. Wave 03 read-only rules vs repair claims
- MECE Wave 04 is explicitly read-only, and its `WAVE.md` says no productive file modifications.
- The repository contains uncommitted repairs (diff stat: 122 inserts/50 deletions), including changes to auth/workspace guards, jobs, Ollama, Helmet, and integration status.
- `.mece/SYNTHESIS.md` claims Wave 03 repairs under a "Read-only Verification" framing (`MECE WAVE 03 SYNTHESIS`). This is a labeling conflict: a read-only audit cannot simultaneously "repair" source. The work should be characterized as verified current-state repairs likely produced by prior non-read-only rounds or user changes, not as audited evidence by itself.
- CELL-04 distinguishes code evidence from execution evidence; current code exists for repairs, but this cell did not independently execute mutation tests for those claims.

### 3. Independent evidence for repairs
| Claim | Current-code evidence | Execution evidence | Status |
|---|---|---|---|
| FE duplicate `render()` removal | `public/app.js` diff removes duplicate/dead duplication | Frontend smoke 7/7 | Verified |
| FE debug log removal | diff removes `console.log("SUBMIT EVENT")` | Source inspect | Verified |
| Ollama 30s timeout | `src/ollama.ts: OLLAMA_TIMEOUT_MS`, `AbortController`, 504 route mapping | Mock test assertions in `tests/ollama-security.test.ts`; no live timeout exercised | Partially verified |
| Missing config → 503 | `src/ollama.ts` throws `OLLAMA_NOT_CONFIGURED`; route maps 503 | Mock test | Verified in current code |
| Integration reconciliation | `/api/integrations` status logic | `tests/integrations.test.ts` (prior) | Partially verified / source valid, but separate test count stale |
| Integration trim/empty key | route now trims `apiKey` | Not explicitly tested in listed files | Source-verified, unverified at test level |
| Null-byte → 400 | `serveFile` null-byte check | Not separately executed here | Verified static behavior |
| Secure cookie alignment | `lib/auth.ts` checks `APP_ENV` or `NODE_ENV` | Source + prior role context | Verified |
| Ollama chat workspace auth | current route calls `requireAuthWorkspace` and validates body type/prompt | Mock injection test | Verified current code |
| Helmet frameguard deny | Helmet `frameguard: { action: 'deny' }` | Header checks in prior reports | Verified |
| Lint ignore `.mece-control` | eslint config includes `.mece-control/**` | Lint 0 errors | Verified |
| Job mutation workspace fences | Mutation where clauses include `workspaceId: job.workspaceId` or optional guard | No job workspace mutation test executed in this cell | Partially verified |
| Approval workspace scope | `updateMany({ where: { id, workspaceId } })` and 404 handling | Prior regression claim only | Partially verified, no fresh DB assertion |
| RLS fix | N/A — no code fix; `Job` still lacks table policy | Not live-tested against non-superuser here | Documented environmental blocker |

Current-code evidence can be reviewed directly in the diff, while execution evidence is limited to safe smoke checks and mocked/static unit claims. This is sufficient to move confidence above "claimed only," but it does not constitute end-to-end verification of job, approval, or Ollama success paths.

### 4. Findings incorrectly marked resolved or stale
- `CELL-01` (prior report) claimed `rejectJob` and `requeueDeadLetterJob` had no `workspaceId` fence. The uncommitted diff shows they now include `job.workspaceId` and an optional `opts.workspaceId` guard. The new current-state report reflects this.
- `CELL-02` (prior report) was stale: it claimed the Ollama route was not workspace-scoped and that input validation was missing, but current `src/index.ts` calls `requireAuthWorkspace`, validates string type, trims, and rejects length over 4000. This was a direct inconsistency and has now been corrected.
- `SYNTHESIS.md` says lint 0 errors, 8 warnings. Current lint has 9 because of `tests/jobs-workspace-scope.test.ts`, which may have been added after Wave 03. The lint conclusion remains "pass 0 errors," but the exact warning count is stale.
- `CELL-03` old report was mislabeled "Routing and Security Audit Report" and reflected generic security points, not the required MCP/control-center scope. The report file has now been replaced by a control-center-specific report. Any wave-level conclusion citing the old file title would be wrong.
- `AUDIT.md` still lists "Ollama not in `/api/integrations`" as low prior issue; current integration metadata still has only four providers. This remains correctly unresolved, so no false resolution exists.
- Wave 03's "Repairs" likely include source edits not present in original Wave 03 report draft or `auditor` claims; use current diff as authority, not stale reports.

### 5. Uncommitted changes are acknowledged and protected by this cell
- No files were modified besides `CELL-04/REPORT.md`.
- No `git commit`, `reset`, `stash`, `checkout`, deployment, migration deploy, secret creation, or cleanup was performed.
- The uncommitted changes remain available for user review and commit at their discretion.
- The report files themselves (`CELL-01`–`CELL-04`) are untracked; they now constitute documentation of the verification state but are not committed.

### 6. Remaining verification gaps
1. `tests/security.test.ts`, `tests/jobs-workspace-scope.test.ts`, `tests/ollama-security.test.ts`, and `tests/workspace-isolation.test.ts` were not independently rerun in Wave 04 due the database-mutation/read-only restriction. Their cited counts are baseline evidence, not fresh proof.
2. No adversarial cross-workspace job scenario (crafted second workspace / shared IDs) was executed.
3. `Job` remains without database RLS; its protection is application predicate-based only.
4. Optional `opts.workspaceId` guards mean callers are not forced to provide tenant scope.
5. Successful `/api/ollama/chat` response/content extraction remains unverified without Ollama credits.
6. No true MCP server connected state, dashboard HTTP smoke, or agent automation run was verified in this wave; prior reports supply that evidence.
7. No browser or Playwright validation has been available.
8. Report count creep (new test files) needs re-baseline before any next wave claims.
9. There is a risk of stale report titles/labels if future waves do not rewrite mislabeled files fully.

## Open risks from a regression perspective
- Hidden regression in job helper concurrency cannot be ruled out because tests were not executed (outside safe non-DB subset).
- Lint count mismatch is not a functional failure but affects evidence accuracy.
- Untracked reports/source changes can be lost or overwritten; no backup was created in this wave (per read-only mandate).
- Stale prior reports still exist in repository (e.g., `.mece/AUDIT.md`) and may conflict with this wave's current source.
- Ollama 402 remains an external commercial blocker; code cannot resolve it.
- RLS environmental dependency means a local run cannot prove production isolation.

## Blockers and limitations
- Read-only mandate prohibited source edits, database migrations, DB-mutating tests, paid/external model calls, dangerous operations, and commits.
- Only safe verification (typecheck, lint, build, health/frontend health smoke) was executed. This does not include integration, security integration, job lifecycle, or Ollama models.
- The conductor, not this subagent, owns final synthesis construction. This report should be consumed before any further synthesis.
- Counts in this report are a mixture of current safe execution and referenced prior evidence; both are explicitly labeled.

## Confidence
- Static code and diff understanding: high.
- Job-helper isolated-fence assessment: medium-high (source evident, runtime not independently tested).
- Ollama route/auth/error behavior: high at source, low for live success.
- Report/test consistency assessment: medium-high, subject to stale historical counts.
- RLS environment statement: high as documented limitation, no fresh DB evidence.

## Recommended next (no execution here)
- Re-baseline test count when the read-only mandate lifts and tests can safely run.
- Add tests for Ollama route status mappings and error bodies at mocked `ollamaChat`, and a workspace-scoped job helper regression suite.
- Require workspaceId in job helper signatures or remove unscoped exported helpers.
- Add FORCE RLS migration for `Job`.
- Replace reliance on `.bak` config backups with append-only redacted logs or safe backup cleanup.
- Preserve all uncommitted changes until the user decides commit specifics.
