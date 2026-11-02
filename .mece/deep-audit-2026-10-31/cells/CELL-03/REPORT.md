# CELL-03 — Backend, API, and Ollama Audit

## Scope
Fastify route validation, business flows, rate limits, Ollama mapping, integration metadata, errors, and API contracts.

## Evidence
- `src/index.ts` / `src/ollama.ts` reviewed.
- `src/integrations.ts` registers only yaps, clippingmini, klap, opusclip.
- `npm run typecheck` pass; `npm run build` pass; `node node_modules/vitest/vitest.mjs run` 28/79 tests.
- Ollama route accepts workspace via `requireAuthWorkspace`, fixes model, trims prompt, ignores extra body fields.
- 30 seconds timeout and 504 mapping present.
- Upstream status (including 402) preserved; body discarded.

## Findings

### API-01 (HIGH / external) — Upstream Ollama billing block
- Unique ID: DA-C03-API-01
- File: `src/ollama.ts`, `src/index.ts`
- Cause: Ollama Cloud returns HTTP 402 without usable credits.
- Effect: valid client request returns 402 and no model content; retrying cannot help until account credits are restored.
- Confidence: High (live request recorded in wave history).

### API-02 (MEDIUM) — Ollama omitted from integration metadata
- File: `src/integrations.ts`
- Cause: registry does not include `ollama`, despite dedicated route and env configuration.
- Missing: discoverable status in `/api/integrations`, potential registry/type coverage.
- Confidence: High.

### API-03 (MEDIUM) — Ollama spend is not budget-aware
- File: `src/index.ts` route handlers.
- Cause: rate limits are IP based; no workspace/user budget, kill switch, attribution, or audit event.
- Confidence: High.

### API-04 (MEDIUM) — Unstrict request schemas allow extra fields and stringified keys
- File: route casts `req.body ?? {} as any`, integration API key handling.
- Cause: Ollama requests accept arbitrary additional fields; integration `apiKey` can be coerced by `String(...).trim()` if non-string provided.
- Confidence: High.

### API-05 (LOW) — Rate limit deployment assumptions
- File: `src/index.ts`
- Cause: `trustProxy` not visibly configured; proxy distribution could evade limits or over-throttle grouped clients.
- Confidence: Medium.

### API-06 (LOW) — unknown non-GET API paths
- File: `src/index.ts`
- Cause: explicit GET handler only; non-GET handling depends on Fastify default.
- Impact low but API behavior asymmetry may confuse clients.
- Confidence: High.

### API-07 (MEDIUM) — API health depends on DB transaction discipline
- File: expansive workspace transaction use across `src/index.ts`.
- Cause: any unscoped direct query bypasses intended tenant behavior.
- Evidence: Job route was repaired; remaining API routes need similar auditing.
- Confidence: Medium-high after hardening.

## Reproduction
- `POST /api/ollama/chat` in local test mode seizes route 402/504 based on mocked behavior.
- Web requests pass lint/API test in local server.

## Recommendations
- Fund Ollama account or add independently verified provider.
- Include Ollama in integration registry metadata.
- Add spend attribution, workspace/user quotas, and documented budget behavior.
- Validate request bodies using Zod/schema for Ollama and integration channels.

## Blockers / limits
- No funding was available; external provider is required for successful live Ollama response proofs.
