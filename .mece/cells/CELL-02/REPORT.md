# CELL-02 — Ollama and API Verification Report

## Scope

Read-only audit of the current working tree, with emphasis on `src/ollama.ts`, the Ollama route and integration/rate-limit code in `src/index.ts`, `src/config.ts`, `src/integrations.ts`, relevant tests (`tests/ollama-security.test.ts`, `tests/integrations.test.ts`, `tests/health.test.ts`, `tests/frontend-smoke.test.ts`, security tests), and prior wave/audit reports. Only `/data/data/com.termux/files/home/ugc/.mece/cells/CELL-02/REPORT.md` was written. No productive files were modified, no database mutations were made, and no external Ollama/model/paid request was issued.

This cell was performed against uncommitted repository changes. Those changes include the Ollama route and security test, integration status reconciliation, prompt validation, timeout/error mapping, and related repairs. Findings below describe the current code, not the pre-change design.

## Environment

- `APP_ENV=development`
- PostgreSQL reachable; tests are expected to require a valid `DATABASE_URL` and `SESSION_JWT_SECRET`.
- Node runtime as recorded by prior conductor checks: v26.x (prior reports cite v26.12.1).
- `OLLAMA_API_KEY` is optional environment configuration and is treated as server-side only. A prior real route request reached Ollama Cloud and returned HTTP 402, which indicates a server-side key was configured at audit time. The key value was not read, printed, or exported in this report.
- The repository contains uncommitted modified and untracked files; those changes were preserved.

## Verification commands/checks

No new commands were run inside this read-only cell. The following were referenced from conductor-recorded checks for the current tree:

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
- Production build → exit 0, including generated Prisma client copy to `dist/src/generated`.
- `node node_modules/eslint/bin/eslint.js .` → 0 errors, 9 warnings (`.mece-control/**` ignored).
- Targeted health/frontend smoke checks → 7/7 passed (1 health test + 6 frontend smoke tests).
- Source inspection of `src/ollama.ts`, `src/index.ts`, `src/config.ts`, `src/integrations.ts`, tests, and prior reports.
- No live `POST /api/ollama/chat` model request was made during this cell. The only recorded live Ollama attempt returned HTTP 402 and no model content.

## Findings

### API-11 — Ollama chat route is now workspace-scoped and membership-gated

- Location: `src/index.ts:1075-1104`; `src/index.ts:129-140` (`requireAuthWorkspace`)
- Verified status: Verified current behavior.
- Evidence: The route calls `requireAuthWorkspace(req, reply)` and returns early if `ctx` is absent. `requireAuthWorkspace` verifies the session cookie, requires an `X-Workspace-Id` (or query) workspace ID, validates its format, and checks `prisma.membership`. Missing session returns 401; missing workspace ID returns 400 `WORKSPACE_ID_REQUIRED`; invalid format returns 400 `INVALID_WORKSPACE_ID`; missing membership returns 403 `NOT_A_WORKSPACE_MEMBER`.
- Risk remaining: authorization is membership-only; every workspace member (including non-admin roles) can trigger server-side Ollama spend. The route does not write an audit event, attribute spend to `ctx.workspaceId`/`ctx.userId`, check a workspace budget, or honor a kill switch.

### API-12 — Prompt validation rejects non-string input and bounds length after trimming

- Location: `src/index.ts:1078-1084`; `src/ollama.ts:1-13,19`
- Verified status: Verified for prompt handling; partial for whole request body/schema.
- Evidence: `rawPrompt` is selected from `body.prompt` (falling back to `body.message`) only when `body.prompt !== undefined`; values that are not strings return 400 `INVALID_INPUT` without coercion; missing prompt also returns 400. The accepted string is `.trim()`ed, empty values are rejected, and values longer than 4000 characters are rejected. The model sent to Ollama is fixed to `glm-5.3-flash` in `src/ollama.ts`; the client cannot override it through this route.
- Partial/unverified aspect: the route still casts `req.body ?? {}` to `any`, accepts arbitrary additional fields, and does not enforce a request schema. Integration configuration still coerces `apiKey` via `String(...).trim()`, so a non-string, non-empty object value can become configured.

### API-13 — Timeout and upstream error handling are repaired; upstream status still leaks

- Location: `src/ollama.ts:11-62`; `src/index.ts:1086-1103`
- Verified status: Verified.
- Evidence:
  - `OLLAMA_TIMEOUT_MS = 30000`; fetch uses an `AbortController`, and `AbortError` maps to `OLLAMA_TIMEOUT`.
  - Route maps `OLLAMA_TIMEOUT` to HTTP 504.
  - An upstream non-OK response reads and discards the body, then throws `OLLAMA_HTTP_<status>`; the status is parsed and mapped only when `400 <= status <= 599`, otherwise the route returns 502.
  - If the HTTP response is OK but JSON parsing fails, `ollama.ts` throws `OLLAMA_INVALID_RESPONSE`; the route maps it to HTTP 502 with generic `OLLAMA_REQUEST_FAILED`.
  - Other/unknown failures fall through to HTTP 502 with generic `OLLAMA_REQUEST_FAILED`.
  - The original error is logged server-side through `req.log.error(err)`; the client response uses a generic message and no upstream body is forwarded.
- Residual risk: HTTP status remains visible to the client; no response-body size cap, retry/backoff, or circuit breaker exists; `response.json()` itself is not independently bounded beyond the overall abort signal.

### API-14 — Missing Ollama configuration is explicitly handled

- Location: `src/ollama.ts:13-17`; `src/index.ts:1088`
- Verified status: Verified/repaired.
- Evidence: `ollamaChat` trims `process.env.OLLAMA_API_KEY`, throws `OLLAMA_NOT_CONFIGURED` when it is absent or blank, and the route returns HTTP 503. `OLLAMA_API_KEY` is never returned by this route or by integration metadata.

### API-15 — Rate limiting exists but is IP-based and not budget-aware

- Location: `src/index.ts:35-36,1075`
- Verified status: Verified limitation.
- Evidence: the global Fastify rate limit is `max: 100` per minute; the Ollama route limit is `max: 20` per minute. These limits are keyed by IP/request address, not by workspace or user. There is no per-workspace bucket, no per-user quota, no Ollama spend ledger, no budget cap, no route-level kill-switch check, and no audited usage attribution. `trustProxy` configuration is not visible in the registration, so proxy behavior and distributed-client limiting must be reviewed separately.
- Risk: any authenticated member of any workspace can spend Ollama credits until the coarse IP limits are reached. The Ollama route is not connected to the workspace `KillSwitch` model or a budget mechanism.

### API-16 — HTTP 402 means Ollama billing/payment required, not application auth failure

- Location: `src/ollama.ts:38-41`; `src/index.ts:1091-1093`; prior audit evidence
- Verified status: Verified source mapping; upstream behavior partially verified; success path unverified.
- Meaning: when Ollama Cloud returns HTTP 402, the account lacks usable credits/payment. In this app it maps to HTTP 402 with error `OLLAMA_REQUEST_FAILED` (generic message; `OLLAMA_REQUEST_FAILED`). It is not a 401 authentication failure, retrying the same request will not help, and funding credits or adding another verified provider is required before real model responses can be tested.
- Boundary: no paid request was made in this cell. The test mock confirms preservation of the 402 status and suppression of the upstream body, but a live success response remains unverified.

### API-17 — Ollama key is server-side only; upstream error body is suppressed

- Location: `src/ollama.ts:14,27`; `src/index.ts:244-261,1091-1093`; `src/integrations.ts:1-25`
- Verified status: Key leakage not found; status/detail exposure is controlled.
- Evidence: `OLLAMA_API_KEY` is read with `process.env` directly in `src/ollama.ts`, used only in the server-side `Authorization` header for the fixed `https://ollama.com/api/chat` URL, and is never stored in a workspace integration row or returned to a client. Integration configuration stores only status plus a masked `hint: "***"` value. Route and source logging expose `OLLAMA_HTTP_<status>` only; the upstream response body is deliberately discarded and not forwarded. No secret value was printed in this audit.

### API-18 — Ollama remains outside integration metadata

- Location: `src/integrations.ts:1-25`; `src/index.ts:228-261`
- Verified status: Verified current design/limitation.
- Evidence: `Provider` and `PROVIDERS` contain only `yaps`, `clippingmini`, `klap`, and `opusclip`; `/api/integrations` therefore returns four entries and cannot report Ollama configuration through that registry. Ollama is configured globally through `OLLAMA_API_KEY` and represented only by `POST /api/ollama/chat`, which returns 503 when unavailable. `tests/integrations.test.ts` expects four providers. This is a discoverability/metadata inconsistency rather than a key leak; changing it would require registry, route, frontend, and test changes.
- Repaired separately: stored provider status is now reconciled with environment status. If the database says `CONFIGURED` but the corresponding server-side environment key is missing, `/api/integrations` reports `NOT_CONFIGURED`.

## Acknowledged uncommitted changes

The audit was performed on the current working tree, including uncommitted modifications and untracked files. Notable relevant changes were acknowledged and verified against actual code:

- Added `src/ollama.ts` with 30-second timeout, missing-key, and upstream mapping handling.
- Added and changed `tests/ollama-security.test.ts` to assert auth/workspace, non-string prompt rejection, 401/400/503/504/402, and non-leak behavior using a mocked `ollamaChat`.
- Modified `src/index.ts` to add the workspace-scoped Ollama route, prompt type/trim/length validation, integration status reconciliation, integration key trim/empty rejection, null-byte path guarding, SPA `api/*` 404, job scoping, and approval scoping.
- Added `.env.example` Ollama key placeholder and updated `AGENTS.md`; preserved.

No attempt was made to commit, stash, revert, or otherwise alter uncommitted changes.

## Confirmed repairs (Wave 03/04 current tree)

- 30-second `AbortController` timeout is implemented in `src/ollama.ts` and mapped to 504.
- Missing Ollama configuration returns 503 `OLLAMA_NOT_CONFIGURED`.
- Invalid upstream JSON is handled as `OLLAMA_INVALID_RESPONSE` / 502 instead of an unhandled 500.
- Upstream HTTP body is discarded; the client receives a generic message while the upstream status itself is preserved in the response status code.
- Ollama route now enforces session + workspace membership plus strict prompt type/trim/length validation.
- Integration status now resolves to `NOT_CONFIGURED` when DB status is `CONFIGURED` but server-side provider environment credentials are absent.
- Integration API key input is trimmed and empty values are rejected; only `{ hint: "***" }` is stored/returned.
- No integration response includes a raw provider key.

## Verified not defects / expected current behavior

- TypeScript typecheck passes.
- Production build passes.
- Lint passes with 0 errors and 9 warnings after ignoring `.mece-control/**`.
- Targeted health/frontend smoke checks pass (7/7).
- Global and route rate limits are present.
- Route hard-codes the model, reducing client-driven model-cost escalation.
- Upstream URL is fixed and request body is constructed with `JSON.stringify`; no client-controlled URL.
- Prompt length over 4000 characters is rejected.
- Non-string prompts, including objects/arrays/numbers, are rejected without coercion on the Ollama route.
- Integration test verifies four providers and stores no raw secret.
- Integration status reconciliation is verified by source inspection and compatible with the four-provider test.

## Open risks and blockers

1. No successful Ollama response can be verified without paid credits; 402 remains an external billing blocker.
2. There is no automated integration test exercising a real upstream response, content extraction, latency, or invalid JSON upstream behavior.
3. Ollama spend is not attributed to a workspace/user, not budget-gated, not kill-switch-gated, and available to all workspace members.
4. No runtime response-size cap, retry/backoff, or circuit breaker protects Ollama calls.
5. Ollama is absent from `/api/integrations` metadata, so its status is not discoverable/configurable through that endpoint.
6. Integration key validation still coerces arbitrary values via `String(...)`, unlike the stricter Ollama prompt validation.
7. The local superuser PostgreSQL role can bypass `FORCE RLS`, so workspace-isolation DB assertions are environment-dependent.
8. `trustProxy`/proxy-aware rate limiting behavior should be reviewed for production deployment.

## Coverage and confidence

- Static code evidence: high.
- Authentication/workspace boundary evidence: high.
- Prompt validation evidence: high.
- Timeout/upstream error mapping evidence: high (invalid JSON branch verified in code; upstream 402 externally blocked).
- Successful model response/content extraction: unverified due to billing blocker.
- Secret exposure evidence: high for key; upstream status still intentionally visible.
- Integration metadata consistency evidence: high (Ollama remains intentionally absent).
- Cost-control/governance evidence: high as a verified limitation.

---

## Wave 04.1 hardening update
- `Job` lifecycle reads and mutations now run through `withWorkspaceTransaction(job.workspaceId)` around update and read-back operations.
- `getJob`, `claimJobById`, `rejectJob`, `requeueDeadLetterJob`, and the remaining initial helper reads now resolve through `readJob(jobId, requestedWorkspaceId)`.
- Route-level workspace checks were tightened to use `getJob(id, ctx.workspaceId)` instead of unscoped primary-key reads; helper calls now forward `workspaceId`.
- Orchestration calls forward `workspaceId` to job helpers. TypeScript strict checks pass.
