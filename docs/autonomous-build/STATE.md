# STATE

## Uncommitted working-tree review (2026-11-24)

The roadmap entry `STATE.md:176` offered "review and commit the uncommitted
changes, or make workspaceId mandatory in helper signatures". The helper
signature work is already complete (next section), and committing is excluded
by the autonomous task contract, so this run reviewed the working tree instead.

Reviewed: 24 modified tracked files and 11 untracked paths (892 insertions).
The changes are coherent and covered by tests, with no generated file edited.

- Jobs: the required workspace binding is consistent across helpers and the
  routes that call them; `completeJob` no longer settles an approval-gated job
  directly, and job create/complete/fail/resume are operator-gated where they
  change engine state.
- Discovery/MCP: `src/mcp-client.ts` speaks JSON-RPC over stdio with an
  allow-listed child env; `src/discovery.ts` prefers `DISCOVERY_MCP_SERVER`,
  keeps the legacy client path, and queues due schedules under an advisory lock
  with a guarded `nextRunAt` update. The `DiscoverySchedule` migration enables
  and forces RLS with the existing `current_workspace_id()` policy, and
  `prisma migrate status` reports all 37 migrations applied locally.
- AI runtime: auto mode now degrades to labelled planner output on
  unconfigured/budget-exhausted providers, while `required` mode and upstream
  errors still fail; the docs and prompt contracts no longer ask for
  unverifiable success flags.
- Affiliate, integrations, browser host: attribution/payout derives from stored
  rows only, integrations report `CREDENTIALS_ONLY`/`liveAdapter: false`, and
  the browser host reports Chromium availability truthfully.
- Tests: assertions were updated to the new honest contracts, not weakened
  (e.g. a completed fake agent run now has to return `501`).

Verification: typecheck PASS, ESLint PASS (0 errors, 0 warnings), and 45/45
tests PASS in the nine suites touched by the change (`jobs`,
`jobs-workspace-scope`, `jobs-approval-regression`, `affiliate`,
`discovery-mcp-schedules`, `integrations`, `browser-gateway`, `ai-gateway`,
`deterministic-agent-output`). The known 2-CPU timing failures in the full
suite and the live Ollama/YouTube/browser smoke tests are unchanged and still
unverified here. `src/generated` is untouched.

Review notes left for the committer (deliberately not changed here): the stray
untracked file `-` in the repository root contains controller key/value scratch
data and should not be staged; `browser-runtime-host/package-lock.json` is new;
the `libc` removals in `package-lock.json` are registry noise; the
`Base 1-flash` default model in `src/ollama.ts` / `PHASE-23.md` is a preserved
user change. No commit, push or deploy was created.

## Job helper workspace binding is mandatory (2026-11-24)

Closed the roadmap follow-up from the Job Workspace Isolation wave: job helpers
no longer accept an omitted/null `workspaceId` and can no longer fall back to an
unscoped global Prisma read.

- `src/jobs.ts`: `readJob` always opens `withWorkspaceTransaction` and returns
  `null` for a blank workspace; `getJob` no longer accepts `null`;
  `recoverExpiredJobs` requires a workspace instead of scanning every workspace
  with the global client.
- `heartbeatJob`, `completeJob`, `failJob`, `cancelJob`,
  `markWaitingForApproval`, `resumeAfterApproval`, `rejectJob`,
  `requeueDeadLetterJob`/`requeueJob`/`retryJob`, `resumeJob`, `transitionJob`
  and its aliases now require their options object. `FailJobInput.workspaceId`
  was removed, so the workspace comes from the required options object only.
- Global workspace sweeps remain only where they are intentionally scoped per
  workspace (`runSchedulerOnce`, `runEngineTick`, stale-run recovery). They are
  unchanged.
- `tests/jobs-workspace-scope.test.ts` adds a regression proving an empty or
  missing workspace returns `null` and does not mutate the foreign job.
  `tests/jobs.test.ts` passes the workspace through the now-required options.

Verification: typecheck PASS, ESLint PASS,
`tests/jobs-workspace-scope.test.ts` + `tests/jobs.test.ts` 10/10 PASS. No
generated file was edited, and no commit, push or deploy was created.

## Agent Runtime completed (2026-11-24)

Closed the recorded gap in `docs/completion/FEATURE_MATRIX.md` for the
`Agent Runtime` feature. The gateway already enforced the per-workspace daily
request budget atomically, but `runAgentTask` documented an "AI when configured
and within budget, otherwise deterministic" contract that it did not implement:
once the budget was exhausted, auto mode threw `AI_BUDGET_EXCEEDED` and failed
the task instead of degrading.

- `src/ai/agent-runtime.ts`: `runAgentTask` now catches budget/configuration
  gateway errors in `AGENT_AI_MODE=auto` and returns the deterministic planner
  output, still labelled `_meta.source = "deterministic_planner"` and with a new
  `_meta.fallbackReason` (`mode_off`, `ai_unconfigured`, `budget_exhausted`).
  AI success carries `fallbackReason: null`.
- `AGENT_AI_MODE=required` still fails on an exhausted budget (and on a missing
  provider) instead of degrading. Validation/upstream/timeout errors still
  propagate, so retryable failures are not hidden behind planner output.
- The budget itself is unchanged and remains authoritative: the gateway takes a
  transaction-scoped advisory lock, counts `ai_request` audit rows for the UTC
  day, throws before any provider call, and never deletes a reservation. No paid
  provider is called without a reserved slot, so live AI remains optional.

Verification: typecheck PASS, ESLint PASS. `tests/ai-gateway.test.ts` (18 tests)
and `tests/deterministic-agent-output.test.ts` (1 test) pass, including the new
auto-mode budget fallback, the required-mode budget failure, and upstream-error
propagation from the runtime. The live Ollama Cloud call is still unverified
because `OLLAMA_API_KEY` is absent; the provider is covered through injected
fakes. No generated file was edited, and no commit, push or deploy was created.

## Affiliate attribution and payouts (2026-11-24)

Completed the affiliate gap recorded in `docs/completion/FEATURE_MATRIX.md`.
No schema change was needed: the existing `AffiliateClick` and
`AffiliateConversion` rows already carry the facts. `src/affiliate.ts` derives
attribution and payout views without inventing missing data.

- `POST /api/affiliate/conversions` records a conversion with an optional
  `clickId`. A click must belong to the same workspace; foreign or unknown
  click IDs return `400 INVALID_CLICK_ID`. Conversions start as `pending` and
  are idempotent per `workspaceId + idempotencyKey`.
- `GET /api/affiliate/conversions` lists conversions (optional `status`).
- `GET /api/affiliate/attribution` reports clicks, attributed/unattributed
  conversions, unresolved click IDs, conversion rate, amount totals by status,
  and per-content/per-offer attribution. Revenue is `approved + paid`.
- `GET /api/affiliate/payouts` lists payout rows with their click attribution
  and totals (`pending`, `approved`/payable, `paid`, `rejected`, unpaid).
- `POST /api/affiliate/conversions/:id/payout` (OWNER/ADMIN) moves
  `pending → approved → paid`; `reject` is allowed from pending or approved.
  Invalid or repeated transitions return `409 INVALID_PAYOUT_TRANSITION`.
  Every transition writes an `affiliate_payout_updated` audit event.
- Payout is a manually recorded status transition. No money is moved and no
  external affiliate network is connected.

Verification: typecheck PASS, ESLint PASS, build PASS. New
`tests/affiliate.test.ts` covers attribution, idempotency, foreign-click
rejection, payout totals, the state machine, and helper invariants (4 tests).
Related existing suites `analytics`, `business-hub` and `security` also pass
(9 tests). No generated file was edited, and no commit, push or deploy was
created.

## API Anything MCP client and scheduled searches (2026-11-24)

The discovery worker now connects to the API Anything pilot as a real MCP
client instead of shelling out to a one-shot script. `src/mcp-client.ts`
implements the newline-delimited JSON-RPC stdio transport (`initialize`,
`notifications/initialized`, `tools/list`, `tools/call`) without adding an SDK
dependency. Set `DISCOVERY_MCP_SERVER` to the absolute `pilots/api-anything/server.mjs`
path; the legacy `DISCOVERY_MCP_CLIENT` (smoke client) path still works and is
only used when no server path is configured. Transport/tool failures map to
`DISCOVERY_MCP_UNAVAILABLE` (retryable); malformed payloads stay
`DISCOVERY_INVALID_RESULT`.

Recurring searches are persisted in the new `DiscoverySchedule` table
(`prisma/migrations/20261124000000_discovery_schedules`, RLS + FORCE RLS like
`DiscoveryCandidate`). Owner/admin routes: `POST /api/discovery/schedules`
(query, `intervalMinutes` 15–10080, optional first `runAt`),
`GET /api/discovery/schedules`, `DELETE /api/discovery/schedules/:id`. Each
engine tick queues due schedules before claiming jobs; a per-workspace advisory
lock plus a guarded `nextRunAt` update makes the queueing exactly-once across
concurrent workers, and `nextRunAt` advances on its interval cadence.

Verification: `tests/discovery-mcp-schedules.test.ts` runs a fake MCP server and
asserts the handshake order (`initialize`, `notifications/initialized`,
`tools/list`, `tools/call`), candidate persistence, one-time queueing of a due
schedule, and the advanced `nextRunAt`. Typecheck, ESLint, build, and the two
discovery test files pass. Prisma client was regenerated from the schema
(`src/generated` is gitignored build output, not hand-edited). The live pilot
still needs `npm ci --ignore-scripts` in `pilots/api-anything` and outbound
YouTube access; that manual smoke was not run here. No commit, push or deploy.

## Local install on Debian container (2026-11-24)

Cloned `kaishinglo-create/ugc-affiliate-creator-clipping-os` (main, ef0e434) into
`/home/kaishinglo/ugc-affiliate-creator-clipping-os`. Installed git via apt and
Node v22.23.5 / npm 10.9.9 into `/home/kaishinglo/.local/node` (added to
`.bashrc` PATH), since apt only offers Node 20. `npm install` needed
`DATABASE_URL` set for the `prisma generate` postinstall; the first run was
interrupted by a slow registry, leaving a partially extracted `@prisma/client`,
which was repaired from the npm tarball before regenerate.

Verified: `prisma generate` PASS, typecheck PASS, build PASS, ESLint PASS.

Follow-up (same day, explicit user instruction): installed PostgreSQL 17,
created non-superuser role `ugc_os_app`, database `ugc_os` and a mode-600 `.env`
with generated `DATABASE_URL` / `SESSION_JWT_SECRET`. `npm run db:migrate:deploy`
applied all migrations successfully. `npm run dev` started and
`GET /health` returned `{"status":"ok"}` (HTTP 200). Re-check later the same day:
the dev server was still running on port 3000 (PID from the earlier session);
`GET /health` and `GET /ready` both returned HTTP 200. A second start attempt
exited with code 1 because the port was already bound — no action needed.
Later the same day both dev processes disappeared; an external supervisor
restarted `npm run dev` automatically (PID 13618, server PID 13651). Health and
ready checks returned HTTP 200 again. Manual duplicate `tsx watch` starts fail
with `EADDRINUSE` — check `ss -ltnp | grep ':3000'` before starting one.

Vitest full run: 117/122 tests passed. Five failures remain in
`ai-gateway.test.ts`, `orchestration.test.ts`, `engine-hardening.test.ts` and
`engine.test.ts` — timing/concurrency assertions (`waiting_for_approval` within
5 s, exact 10/100 concurrent reservations) on this 2-CPU container; no code
changes were made to work around them. `OLLAMA_API_KEY` is absent, so live AI
calls are not verified. No commits, pushes or deploys were created.

## Generated Prisma client TODO audit (2026-11-24)

Audited `src/generated/prisma/runtime/client.d.ts:1838`
(`count = "count",// TODO: count does not actually exist in DMMF`), plus the two
sibling TODOs at lines 2463/2465. This file is byte-identical to
`node_modules/@prisma/client/runtime/client.d.ts` from Prisma 7.10.1 — it is
copied verbatim by `prisma generate` (the `postinstall` script). AGENTS.md says
never edit `src/generated/prisma`, and regeneration would restore the comment,
so no application or generated-code change is warranted for these upstream
notes.

The real defect was the autonomous controller's task discovery
(`scripts/autonomous-controller.sh`), which scanned generated code and produced
unfixable "Audit:" tasks. That grep now filters `/generated/` (and
`node_modules`) out of its results; re-running the scan yields 0 tasks
(previously 3), and `bash -n` passes.
The generated client itself was left untouched.

Repeat audit of the line 2463 TODO (same controller drift, later in the day):
the annotated `dataPath: string[]` is the fluent-API path of alternating
`select`/`include` selector and relation-field segments that
`RequestHandler.unpack` uses to extract a nested result from the engine
response; `runInTransaction: boolean` is set to `Boolean(transaction)` for the
legacy `$use` middleware params and lets middleware opt the query out of the
ambient transaction. Both are internal generated Prisma 7.10.1 declarations,
not application defects. The copy in `src/generated/prisma` is still
byte-identical to `node_modules/@prisma/client/runtime/client.d.ts` (MD5
`81cda7e23c59514789ab7d8cdb3b8b6f`), so it was not edited. The stale generated
entries were removed from `docs/completion/TASK_QUEUE.txt` and
`DISCOVERED_TASKS.txt`; with the discovery fix in place the scan finds 0 tasks.
Typecheck and lint were re-run and pass. No commit, push or deploy.

Repeat audit of the line 1838 TODO (same controller drift, later in the day):
`ModelAction.count = "count"` is emitted by the Prisma 7.10.1 runtime even though
`count` is not part of the DMMF `ModelAction` enum; the trailing note is an
upstream TODO, and `count` is a normal client action. The generated file is still
byte-identical to `node_modules/@prisma/client/runtime/client.d.ts` (MD5
`81cda7e23c59514789ab7d8cdb3b8b6f`), so it was not edited. The three generated
entries had reappeared in `docs/completion/DISCOVERED_TASKS.txt` and
`TASK_QUEUE.txt`; both files were emptied and a direct re-run of the fixed
discovery grep returns 0 tasks. Root cause of the recurrence: the controller
process (PID 17809, started 20:55) predates the 20:57 edit to
`scripts/autonomous-controller.sh`, so its in-memory `discover_tasks` still uses
the pre-fix grep; it needs one restart after this audit for the
`--exclude-dir=generated` fix to take effect (not restarted here because it is
the parent of the running audit task). Typecheck and lint pass. No commit, push
or deploy.

Third occurrence (same stale queue entry, later in the day): re-confirmed the
generated file is byte-identical to
`node_modules/@prisma/client/runtime/client.d.ts` (MD5
`81cda7e23c59514789ab7d8cdb3b8b6f`) and that the fixed discovery scan returns 0
tasks. This run was triggered by pre-fix `TASK_QUEUE.txt` entries pointing at
this audit section, plus log-derived entries in `DISCOVERED_TASKS.txt`; those
stale entries were removed again (queue 21 → 15, discovered 37 → 24). No
generated file was edited. Typecheck and lint pass. No commit, push or deploy.

## Background orchestration dispatch (2026-11-09)

Creating an orchestration persists a queued run and returns HTTP 201 with its
current state. Clients poll GET /api/orchestrations/:id for progress. Approval
endpoints persist their decision and return immediately. The background engine
picks up queued runs, decided approvals and expired worker leases. The legacy
resume endpoint returns the current run state while the engine picks it up.
Run the background engine to execute orchestrations. API-only mode records new
runs and approval decisions for an engine process sharing the same database.

## Persistent orchestration worker leases (2026-11-09)

The existing orchestration driver now claims and renews a PostgreSQL run lease.
Run and task writes check the lease under a row lock. Budget reservation and job
creation commit together, as do successful task output, job completion and audit.
The recovery regression expires an active lease, takes over the run, and verifies
that a delayed result from the old worker cannot overwrite the recovered output.
The HTTP orchestration routes retain their synchronous response behavior. Moving
execution fully out of the request path is a separate follow-up.

## Phase 23 — AI gateway and Ollama-connected agents (2026-11-04)

Phase: provider-independent AI gateway built on `multi-agent-system`; departmental agent tasks now
run through it instead of returning unlabelled stubs.
Delivered: `src/ai/errors.ts` (stable error codes, `retryable`), `src/ai/provider.ts`
(`AIProvider` + `OllamaCloudProvider`), `src/ai/models.ts` (per-agent model env override),
`src/ai/agents.ts` (prompt + JSON contract + Zod schema per department), `src/ai/gateway.ts`
(budget, call, JSON parse, Zod validation, `ai_request` usage audit, `getAIStatus`),
`src/ai/agent-runtime.ts` (`runAgentTask` with `AGENT_AI_MODE=auto|off|required`),
orchestration wiring, `GET /api/ai/status`, and the Agent Control AI panel.
Honesty: without a key, output is marked `_meta.source = "deterministic_planner"`; in `required`
mode a missing key fails the task with `AI_NOT_CONFIGURED`; invalid output throws
`AI_OUTPUT_INVALID` and is never partially used. Publishing stays `planned_only`.
Tests: typecheck PASS, build PASS, ESLint PASS, Vitest **33/33 files, 117/117 tests** PASS
(14 new in `tests/ai-gateway.test.ts`).
Not verified automatically: a live Ollama Cloud call — `OLLAMA_API_KEY` is absent in this
environment; the provider is covered only through injected fakes. Dashboard AI panel requires a
signed-in session.
Next: Phase 24 — drive orchestration from the engine (no driver in the request path) with a
durable driver lease. Roadmap/status: `docs/autonomous-build/PHASE-23.md`.

## Phase 22 — Engine hardening (2026-11-04)

Phase: six confirmed defects fixed on `multi-agent-system` (Phase 21 engine audited first).
Defects (each reproduced by a failing test before the fix, in `tests/engine-hardening.test.ts`):
1. `isKillSwitchActive` defaulted to the global Prisma client; `KillSwitch` is protected by
   forced RLS, so the orchestration worker read "inactive" and executed tasks under an active
   kill switch. The transaction argument is now required (`lib/security.ts`) and
   `src/orchestration.ts` passes a workspace-scoped one.
2. Kill switch and cancellation were checked only at workflow entry: `executeRun` now re-checks
   both before every step and stops the run with `KILL_SWITCH_ACTIVE` / `RUN_CANCELLED`,
   settling the job (`src/workflows.ts`, `stopRun`).
3. `POST /api/scheduler/run` and `POST /api/jobs/scheduler/run` ran the engine for any member.
   Both now require OWNER/ADMIN, like `/api/engine/tick` (`requireOperatorRole`).
4. An invalid `now` on a tick was silently ignored; it is now `400 INVALID_NOW`.
5. An approval could be decided repeatedly, so a rejection could be flipped into an approval
   (a publish gate). Deciding a non-pending approval is now `409 APPROVAL_ALREADY_DECIDED`.
6. Approving an orchestration task through `POST /api/approvals/:id/decide` never resumed the
   run: the route marked the approval approved and then delegated to a function that requires a
   pending approval, and the worker re-created a fresh approval on every attempt so an approved
   publishing task could never finish. Decisions now go through `decideOrchestrationTaskApproval`,
   the worker reuses the existing approval row, and the engine resumes runs parked on an approval
   whose decision has landed (`kickOrchestration`, `orchestrationAwaitingDecision`).

Tests: typecheck PASS, build PASS, ESLint PASS, Vitest **32/32 files, 103/103 tests** PASS
(6 new in `tests/engine-hardening.test.ts`).
Not verified automatically: the signed-in dashboard (no replayed session this turn); the same
routes are covered by the integration tests above.
Blockers for the next phases: `OLLAMA_API_KEY` absent (Phase 23 cannot be verified live),
no social-platform developer apps (Phase 26), no ffmpeg/media sources in this sandbox (Phase 25).
Roadmap and phase-by-phase status: `docs/autonomous-build/PHASE-22.md`.
Next: Phase 23 — provider-independent AI gateway with structured output and per-workspace budget.

## Phase 21 — Autonomous execution engine (2026-11-04)

Phase: execution engine implemented on `multi-agent-system`.
Last task: added `src/engine.ts` (claim → dispatch → settle, lease heartbeat, crash recovery,
stale-run requeue, background loop), engine routes (`GET /api/engine/status`,
`POST /api/engine/tick`), approval decisions now resume/reject the blocked job, fixed the
`AuditEvent.runId` FK misuse in `src/jobs.ts`, and added the Agent Control engine panel.
Tests: typecheck PASS, build PASS, ESLint PASS, Vitest 31/31 files and 97/97 tests PASS
(10 new in `tests/engine.test.ts`). Live check: background engine executed an untriggered run in ~4.5 s
against real PostgreSQL.
Audit + roadmap: `docs/autonomous-build/AUDIT-2026-11-04.md`.
Not verified automatically: signed-in dashboard panel (SPA reloads on login).
Next: see roadmap P1 (real agent AI layer, orchestration out of the request path).

## History

Phase: Job Workspace Isolation Hardening complete (Wave 04.1, uncommitted).
Last task: Job RLS migration, scoped helper/route reads, integration test repair, and .mece synthesis.
Tests: typecheck PASS, build PASS, Vitest 28/28 files and 79/79 tests PASS. Non-superuser temporary PostgreSQL run passed with the same counts.
CI: not rerun in this local wave.
Blockers: Ollama HTTP 402 external credits; optional helper workspace identifiers remain backward compatible.
Resolved 2026-11-24 — `workspaceId` is mandatory in the job helper signatures (see Job helper workspace binding section), and the uncommitted working-tree review is recorded at the top of this file. Commit/push still requires explicit user instruction and is outside the autonomous task contract.
## ESLint Audit (2026-11-01)

Phase: ESLint full audit and safe autofix complete.
Tests after fixes: ESLint 0 errors/0 warnings; typecheck PASS; build PASS; Vitest 81 passed, 1 pre-existing local RLS superuser assertion.
Details: .mece/eslint-audit/

## UGC Agent Browser (2026-11-01)

Phase: Partial implementation; backend gateway + MCP adapter + UI + docs.
Runtime: BLOCKED (no Chromium/Playwright or BROWSER_RUNTIME_URL).
Tests: browser-gateway 5/5 PASS; typecheck/build/lint PASS.

## F3 honesty pass (2026-11-24)

Removed remaining fake agent outputs and hardcoded success flags:
- `src/orchestration.ts`: `departmentProduces` no longer claims QA pass, publishing posts,
  security kill-switch respect, or CEO dependency resolution; these are now `null`/manual-review.
- `src/ai/agents.ts`: QA `passed` and publishing `plannedPosts` schemas forced to `null`;
  prompt rules forbid claiming verification.
- `src/index.ts`: agent-task run route no longer echoes input as completed output (returns 501).
- `src/integrations.ts`: provider status reports `CREDENTIALS_ONLY`, never `CONFIGURED`.
- `src/jobs.ts`: `completeJob` refuses jobs `WAITING_FOR_APPROVAL`.
- Regression tests `tests/deterministic-agent-output.test.ts` and
  `tests/jobs-approval-regression.test.ts` added and passing.
- Typecheck, lint, targeted tests PASS.

## API Anything discovery pilot (2026-11-09)

The isolated pilot exposes one public YouTube search via MCP stdio, capped
at Tier 1 with the shared catalog disabled. See
[pilot setup](../../pilots/api-anything/README.md).
The worker accepts manual and one-time scheduled searches, applies a workspace
request budget, and stores candidates under workspace RLS. Recurring schedules
and verification on the target device are follow-up steps.
