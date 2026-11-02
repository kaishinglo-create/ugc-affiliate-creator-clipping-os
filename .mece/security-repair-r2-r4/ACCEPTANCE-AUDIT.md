# READ-ONLY ACCEPTANCE AUDIT — R2–R4 + BEAM

Audit ID 2026-10-31
Mode: READ ONLY
Result: PARTIAL ACCEPTANCE — code and tests are credible, but live/provider and browser/operator evidence gaps remain.

## A. Verdict matrix

- R2 control-center authentication (server-side, fail-closed unless `MECE_DASHBOARD_TOKEN >= 32` chars): PARTIAL/PASS — static code verified; no execution test was run, only `node --check .mece-control/server.mjs` passed (`100`.99 lines? refs below).
- R2 token comparison (`constantEqualText`, `crypto.timingSafeEqual`): PASS static.
- R2 loopback binding (`127.0.0.1:3031`, `127.0.0.1:4096`): PASS static.
- R2 origin/host check for `/api/`: PASS static (`isAllowedOrigin` and guard at `server.mjs` main handler).
- R2 absence of secrets in body/log: PASS static (error is generic; values not logged).
- R2 historical backup cleanup: PARTIAL at best — historical `.bak` files remain and are not auto-redacted/deleted.
- R2 API route total coverage (all `/api/*` protected): PASS static (`url.pathname.startsWith("/api/")` guard).
- R3 mandatory Job workspace scope:
  - Type-level scope: PASS for changed interfaces (`src/jobs.ts` `JobActionOptions.workspaceId`, `RequeueOptions.workspaceId`, `HeartbeatOptions.workspaceId`, `getJob` scope argument, `claimJobById` scope field).
  - Runtime guard: PASS static (`readJob` + null return if absent; `getJob` returns null; claim mutation checks posted workspace).
  - DB write scope: PASS static (all update paths use `withWorkspaceTransaction` + `workspaceId: job.workspaceId` or requested bound `workspaceId`).
  - Compatibility fallback: PARTIAL — default `{ workspaceId: "" }` placeholders preserve compilation continuity but return null as required at runtime.
  - Explicit worker failures (unknown status/report stale): PARTIAL not directly fuzzed beyond fixture tests.
- R4 body schema/body size: PASS for accepted key shapes, but no explicit Fastify body-limit change was observed beyond default server/body limits.
- R4 `trustProxy`: PASS static (`src/index.ts` lines 15 and 24), with configuration only through `TRUST_PROXY`; no runtime network scenario tested.
- R4 Ollama API budget:
  - Kill switch check before execution: PASS static (call at route); tests only existing static behavior.
  - Workspace daily request cap: PASS static using `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE` with default 100.
  - Transaction concurrency lock: PASS static (`pg_advisory_xact_lock(hashtext(...))` + count).
  - Fail-closed when zero/invalid: PASS static.
  - Default remains 100 requests, a product default; if operators want disabled functionality it is intentionally explicit rather than unlimited.
- R4 Ollama audit privacy: PASS static for prompt content (not stored; only `promptLength`) but PARTIAL for event retention/audit-volume concerns.
- R4 audit outcome mapping: PASS static for known 403, 401, 402, 423, 429, 503, 502, 504; expected tests for success/budget/kill switch not present.
- R4 strict request keys: PASS static (`allowedKeys = ['prompt', 'message']`).
- R4 kill switch tests: PARTIAL (kill-switch route behavior already has workspace-scoped tests elsewhere, but Ollama live requests against active kill switch were not executed).
- Model: PASS configuration via `opencode debug config` for all seven MECE agents, all pointing to `ollama-cloud/beam`.
- Model effective runtime behavior: PARTIAL only — a test invocation would be a paid provider/model call and was not executed in this read-only audit.
- Browser/E2E: FAIL as current proof, explicitly not run.

## B. R2 auth implementation references
- `.mece-control/server.mjs:24`: `DASHBOARD_TOKEN = String(process.env.MECE_DASHBOARD_TOKEN || "").trim()`
- `.mece-control/server.mjs` lines 89–111: `dashboardTokenValid`, `readDashboardToken`, `constantEqualText`, `dashboardAuthorized`.
- Main request guard under `/api/`: lines ~721 onwards in `http.createServer` handler.
- Static `GET /` is intentionally not auth guarded (dashboard shell).
- `GET /api/bootstrap` now returns `dashboardAuthEnabled`.

R2 caveat: after guard, all API paths reject when token absent. No automated control-center tests were located in repository.

## C. R3 job helper and caller references
Caller audit `grep` confirms all active application callers pass workspace:
- `src/index.ts` routes: `getJob(id, ctx.workspaceId)`
- `src/index.ts` action routes: workspace `workspaceId` forwarded after `getJob`.
- `src/orchestration.ts`: `getJob`, `heartbeatJob`, `failJob`, `cancelJob`, `markWaitingForApproval`, `completeJob`, `claimJobById` all pass `workspaceId`.
- `transitionJob` initializes via `readJob` and switches/canonicalizes to `job.workspaceId`.
- Tests pass workspace (`tests/jobs.test`, `jobs-hardening`, `jobs-workspace-scope`).
- No external callers without workspace observed in application code.

Functional/acceptance evidence:
- `tests/jobs-workspace-scope.test.ts` covers `getJob`, `claimJobById`, requeue, reject, route 404.
- Non-super test suite: 28 files / 79 tests passed.
- `bash?` Git status unclean with exact baseline recorded earlier.

## D. R4 implementation references
- `src/index.ts` lines 15-24: trustProxy logic.
- `/api/ollama/chat` is near line 1091.
- Uses `requireAuthWorkspace` (session/workspace membership).
- `body` schema enforced with allow-list only (`prompt`, `message`).
- Workspace-scoped kill switch call:
  - import and call `isKillSwitchActive(ctx.workspaceId, tx)`.
- Budget:
  - environment result interpretation.
  - start-of-day boundaries.
  - advisory lock keyed on day/workspace; passed count check.
  - returns 429 on exceeded; 503 on zero/invalid configured budget.
- Audit events:
  - `ollama_request` recorded for budget failure and runtime outcomes.
  - Includes model ('glm-5.3-flash'), prompt length; explicitly sets cost metadata to `"not-supplied-by-provider"`.
  - On successful path, audit is recorded after provider response.
  - On error path, audit record failure is logged but does not override main response logic.

## E. Documentation gap
FAIL (low):
- `.env.example` does not describe `MECE_DASHBOARD_TOKEN`, `TRUST_PROXY`, or `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE`.
- `AGENTS.md` does not describe those new variables either.
- This affects operational acceptance; wrappers cannot know required external settings.

## F. Additional acceptance shortcomings
1. No dedicated tests exist for:
   - dashboard token auth (401/403 and allowed combination),
   - live kill-switch routing in Ollama path,
   - budget-exceeded and concurrency.
2. No control-center execution test.
3. No browser visual/responsive evidence.
4. External `ollama-cloud/beam` success call remains unverified (HTTP 402 upstream), as recorded and not repaired in this wave (not in approval scope).
5. Historical `.bak` files and `.mece-control` secrets are not deleted or redacted by process design.
6. New environment variables must be documented before production rollout.

## G. Test evidence
- Prior verified command logs:
  - Typecheck exit 0.
  - Build exit 0.
  - ESLint exit 0 with 9 warnings.
  - Full test suite under temporary nonsuper role/database exit 0, 28 files / 79 tests.
  - Ollama target suite 8/8 tests passed.
  - Jobs workspace target 14 passed.
  - Control center:
    - `node --check .mece-control/server.mjs` passed.
  - Beam config:
    - Seven agent model fields verified.
    - `ollama-cloud/beam` model availability verified.
  - California style control center status historical warm-up pinned model, but effective server process model cannot be proven without a billed call.

## H. Not executed in this acceptance audit
- No paid/provider calls.
- No database migration or deployment.
- No commits.
- No git reset/stash/clean.
- no control-center functional tests.
- no tests against production database.
- no destructive backup sweeps.

## I. Final recommendation
ABGRENZT BEURTEILUNG (scale):

### For source static and local synthetic test quality: ACCEPT for engineering.
### For operational rollout: DO NOT ACCEPT until:
1. `.env.example`/`AGENTS.md` document new variables.
2. Authenticated control-center integration test (or similar dry non-E2E running test) checks 401/403 and acceptable origin.
3. Audit log behavior under concurrent budget cap is tested or statically proven more formally.
4. A paid-approved probe confirms Ollama success path, or an alternate independently verified provider covers live requests.
5. User commits and migrates only after their own approval.

Thus: **ACCEPT engineering implementation with documentation/test gaps; DO NOT ACCEPT deployment as-is.**
EOF
wc -l .mece/security-repair-r2-r4/ACCEPTANCE-AUDIT.md