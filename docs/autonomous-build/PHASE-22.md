# Phase 22 — engine hardening (2026-11-04)

Branch `multi-agent-system`, starting commit `cbd826f` (reference commit given in the brief).
Every defect below was reproduced with a failing test before the fix and re-verified after it.
Verification in this session: `tsc --noEmit` PASS, `tsc -p tsconfig.json` (build) PASS,
ESLint PASS, `vitest run` **32 files / 103 tests PASS** (97 before, +6 new).

## 1. Audit result — what Phase 21 actually delivered

Confirmed by reading the branch and running it against PostgreSQL (`ugc_os_app`, a
non-superuser role, so row-level security applies):

- `src/engine.ts` exists: claim → dispatch → settle, lease heartbeat during execution, lease
  expiry recovery, stale run requeue, kill-switch gate per workspace, background loop.
- Approval decisions release the blocked *workflow-run* job; `AuditEvent.runId` FK misuse is gone.
- Orchestration (`src/orchestration.ts`) is durable in state but **still driven synchronously
  inside the HTTP request**; agent outputs come from `departmentProduces()` (deterministic stubs).

## 2. Defects fixed in this change

| # | Defect | Fix | File |
| --- | --- | --- | --- |
| 1 | Kill switch read through the global Prisma client. `KillSwitch` has forced RLS, so an unscoped read returns no row and the orchestration worker treated an active kill switch as inactive. | `isKillSwitchActive(workspaceId, tx)` now requires a workspace-scoped transaction (throws otherwise); the orchestration call site passes one. | `lib/security.ts`, `src/orchestration.ts` |
| 2 | Kill switch / cancellation were checked only when a run started. A multi-step workflow kept executing after autonomy was revoked. | `executeRun` re-checks the live run status and the kill switch before every step; `stopRun` cancels the run, records `workflow_run_blocked`, and settles the job as `CANCELLED`. | `src/workflows.ts` |
| 3 | `POST /api/scheduler/run` and `POST /api/jobs/scheduler/run` executed engine work for any workspace member (only `/api/engine/tick` was role-gated). | Both scheduler routes use the new `requireOperatorRole` (OWNER/ADMIN). | `src/index.ts` |
| 4 | An unparsable `now` in a tick body was silently replaced by "now", so a caller could believe it replayed a time window. | Invalid timestamps are rejected with `400 INVALID_NOW`. | `src/index.ts` |
| 5 | An approval could be decided repeatedly: a rejected approval could be flipped to approved after the fact (relevant to publish gates). | Decisions now match `status: 'pending'` atomically and return `409 APPROVAL_ALREADY_DECIDED` otherwise. | `src/index.ts` |
| 6 | Approval dead end for orchestration. `POST /api/approvals/:id/decide` set the approval to approved and then delegated to `decideOrchestrationTaskApproval`, which requires a *pending* approval, so resumption always threw (swallowed). Even when a decision landed, the worker created a **new** approval on the next attempt, so an approved publishing task could never complete and the run stayed `waiting_for_approval` forever. | The decide route delegates orchestration approvals to `decideOrchestrationTaskApproval` before touching the row; the worker reuses the task's existing approval (approved → execute, rejected → fail, pending → stay blocked); the engine now also resumes runs parked on an approval whose decision has landed (`kickOrchestration`, `orchestrationAwaitingDecision`). | `src/index.ts`, `src/orchestration.ts`, `src/engine.ts` |

## 3. Regression tests

`tests/engine-hardening.test.ts` (6 tests, all failing before the fixes):

1. a plain MEMBER gets `403` from `/api/scheduler/run`, `/api/jobs/scheduler/run`, `/api/engine/tick`;
   the OWNER still gets `200`.
2. an invalid tick timestamp returns `400`.
3. the kill switch is visible through a workspace-scoped client, and a source scan asserts no
   call site invokes `isKillSwitchActive` without a transaction.
4. a workflow whose first step activates the kill switch ends `cancelled`
   (`KILL_SWITCH_ACTIVE`), the second step never runs, and the job is `CANCELLED`.
5. a rejected approval cannot be flipped; the second decision returns `409`.
6. an orchestration approval granted through `/api/approvals/:id/decide` returns
   `resumed: { entityType, runId }` and one engine tick drives the run to `succeeded`.

## 4. Phase status after this change

| Phase | Status | Evidence / blocker |
| --- | --- | --- |
| 22 — engine hardening | **Delivered (this change)** | 6 verified defects + regression tests; suite 103/103 |
| 23 — real AI agents | **Not started — blocked for live verification** | `src/ollama.ts` is a single provider/model with a daily request cap and no schema validation, fallback or usage accounting. No `OLLAMA_API_KEY` is present in this environment, so a real call cannot be exercised; the work is implementable behind a provider interface with a stubbed provider in tests, but claiming "real AI" would be unverified. |
| 24 — persistent company orchestration | **Partially delivered** | Durable state, dependency graph, approvals, retries and budget already exist; approval resumption is now automatic and survives a restart. Remaining: orchestration start no longer blocks the HTTP request (the driver still runs in-request; the engine is the backstop). |
| 25 — video clipping pipeline | **Not started — blocked** | No media pipeline; `departmentProduces('video')` returns hardcoded clips. No ffmpeg or source media in this sandbox, and no storage backend configured. |
| 26 — social publishing | **Not started — blocked** | No OAuth or platform clients; `plan_publication` returns `planned_only`. Requires developer apps/credentials for YouTube/Instagram/TikTok. |
| 27 — affiliate & revenue | **Partial** | `AffiliateClick`/`AffiliateConversion` models and click ingestion exist; no attribution model, reconciliation, payout export or revenue reporting. |
| 28 — dashboard completion | **Partial** | Vanilla SPA with engine monitor panel; no CEO/COO control centre, org chart, video queue or publishing approval centre. |
| 29 — production deployment | **Partial** | CI runs migrate + `npm run check` against Postgres; no Dockerfile/compose, ARM64 check, HTTPS/reverse proxy or backup docs in the repository. |

## 5. Next steps (in order)

1. Phase 24 finish: dispatch orchestration from the engine (no driver inside the request), with a
   durable driver lease so two workers cannot drive one run.
2. Phase 23: provider interface + Ollama Cloud Beam provider, Zod-validated structured output,
   per-agent model config, usage/limit accounting, explicit `AIConfigurationError` (never a fake
   answer). Requires a real `OLLAMA_API_KEY` to verify end to end.
3. Phase 27 truth-first: attribution and reconciliation on stored clicks/conversions, payout
   export, derived revenue reporting (no invented numbers).
4. Phases 25/26 once media access, storage and platform developer apps exist.
5. Phase 29: Dockerfile + compose, ARM64 dependency check, healthchecks, backup/restore docs.
