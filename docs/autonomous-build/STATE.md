# STATE

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
Next: Review and commit the uncommitted changes, or make workspaceId mandatory in helper signatures.
## ESLint Audit (2026-11-01)

Phase: ESLint full audit and safe autofix complete.
Tests after fixes: ESLint 0 errors/0 warnings; typecheck PASS; build PASS; Vitest 81 passed, 1 pre-existing local RLS superuser assertion.
Details: .mece/eslint-audit/

## UGC Agent Browser (2026-11-01)

Phase: Partial implementation; backend gateway + MCP adapter + UI + docs.
Runtime: BLOCKED (no Chromium/Playwright or BROWSER_RUNTIME_URL).
Tests: browser-gateway 5/5 PASS; typecheck/build/lint PASS.

## API Anything discovery pilot (2026-11-09)

The isolated pilot exposes one public YouTube search via MCP stdio, capped
at Tier 1 with the shared catalog disabled. See
[pilot setup](../../pilots/api-anything/README.md).
The worker accepts manual and one-time scheduled searches, applies a workspace
request budget, and stores candidates under workspace RLS. Each workspace can
configure one recurring search, with a three-hour minimum interval and no
replay of missed slots after downtime. Target-device verification is pending.
