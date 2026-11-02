# CELL-API — API Audit Report (READ ONLY)

## Scope
Fastify API routes and related backend modules: authentication/workspace entry, system and business endpoints evidenced as available, product/runtime paths, job runtime, orchestration, integrations, and Ollama provider behavior. Audited API source and tests without modifying code. No cost-triggering outbound model/provider call was newly made.

## Evidence and checks
Commands / references:
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → pass.
- `npm run build` command (`node node_modules/typescript/bin/tsc -p tsconfig.json && rm -rf dist/src/generated && cp -r src/generated dist/src/generated`) → pass.
- `node node_modules/eslint/bin/eslint.js .` → 0 errors, 9 warnings.
- `node node_modules/vitest/vitest.mjs run` → 28 test files, 79 passed in non-superuser temporary run.
- Inspected `src/index.ts`, `src/jobs.ts`, `src/orchestration.ts`, `src/ollama.ts`, related tests.
- Ollama source behavior described as known from WAVE04/WAVE04.1.

## Verified findings

### API-A01 (Medium) — Ollama route is workspace-gated and validates prompt shape
- Route: `POST /api/ollama/chat`.
- Evidence in current source: calls `requireAuthWorkspace`, rejects non-string prompt, trims, rejects empty and >4000 character prompts, and fixes model to `glm-5.3-flash`.
- Risk remains because workspace membership alone, not role or budget, determines authorization to trigger server-side spend.

### API-A02 (Medium) — Ollama timeout and upstream errors are mapped explicitly
- Evidence: `src/ollama.ts` uses 30-second `AbortController`; timeout maps to HTTP 504. Invalid upstream JSON maps to HTTP 502. Upstream non-OK responses retain their upstream status (including 402) while the upstream body is discarded and a generic client message is returned.
- Residual: no retry/backoff, circuit breaker, or response-size bounding beyond the abort signal.

### API-A03 (High / external blocker) — Ollama Cloud requires payment/credits
- Recorded live `/api/ollama/chat` attempt from Wave04 returned HTTP 402, indicating upstream account/payment limitation.
- Local mocked tests confirm preservation of 402 status and generic message. A successful live model response remains unverified without external funding.

### API-A04 (Medium) — Ollama is not represented in integration metadata
- Evidence: `src/integrations.ts` exposes only `yaps`, `clippingmini`, `klap`, and `opusclip`. `/api/integrations` therefore cannot report Ollama health/configuration status even though Ollama uses global `OLLAMA_API_KEY`.
- Verified reconciliation behavior for configured vs missing env keys exists for the four registered providers. Ollama is an unregistered external provider from the frontend perspective.

### API-A05 (Low) — Rate limiting exists but is coarse
- Evidence: global 100 requests/minute and Ollama-specific 20 requests/minute by IP. No user/workspace quota, budget ledger, or kill-switch check is visible in the route path. Proxy assumptions via `trustProxy` were not visibly configured in the audited registration.

### API-A06 (Low / security-leaning) — Request body schema is not strictly constrained
- Evidence: Ollama route casts body to `any`, then selects `prompt` or `message`; additional fields are accepted. Integration key coercion uses `String(...).trim()`, so non-string object values could be stringified.
- This matters because invalid/malformed bodies can pass partially and become opaque strings.

### API-A07 (Medium) — Job hardening and workspace scoping are now materially improved
- Evidence from added migration and helper/helper transaction changes: `Job` RLS migration exists; helper reads/route checks/workspace assumptions were updated and non-superuser tests pass.
- Workspace-owned job helper refactor passed typecheck/build/full suite and temporary non-superuser integration test. This remains source-level and test-backed in a synthetic dataset, not production runtime proof.

### API-A08 (Low) — Optional scopes remain in helper signatures
- Parameters such as `workspaceId` in `JobActionOptions` and related input types are not mandatory. Runtime guards reject mismatched IDs, but callers can omit scope. This is backward-compatible but can increase accidental unscoped usage.

### API-A09 (Low) — Unknown `/api/*` non-GET consistency relies on default behavior
- Source has an explicit `GET /api/*` JSON 404. For unknown non-GET API paths, behavior is Fastify default, though frontend handling may still display an error. This is a minor API consistency finding, not a crash.

### API-A10 (Medium) — Business/API safety depends on transaction context
- Evidence: `withWorkspaceTransaction` sets `app.current_workspace_id`; all workspace-scoped model reads now depend on this. Incorrect route composition can read nothing under RLS or bypass tenant boundaries if a global read is used. Code has been hardened, but future helpers must maintain this pattern.

## Open risks
1. Real Ollama response path is blocked upstream.
2. No Ollama spend attribution/audit/budget.
3. Provider registry and metadata surfaces do not include Ollama.
4. Integration test datasets and role assumptions are synthetic and must still be validated in production-like constraints.

## Blockers
- No live successful Ollama request can be obtained without credits or an independently verified provider.
- No true third-party API integration result can be represented accurately in current local audit.

## Confidence
- API source and route contract understanding: high.
- Ollama behavior except live success: high for source, low for live success.
- Test evidence: high locally; synthetic database role and data only.

## Notes
- No repairs or source edits were performed in this audit cell.
- Ollama credentials were not read or recorded.
