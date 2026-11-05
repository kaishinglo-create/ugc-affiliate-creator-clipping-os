# Phase 23 — AI gateway and Ollama-connected agents (2026-11-04)

Branch `multi-agent-system`. This phase adds a provider-independent AI gateway and routes
departmental agent tasks through it, replacing the unlabelled deterministic stubs the
orchestration worker used to return.

## 1. What was built

| File | Purpose |
| --- | --- |
| `src/ai/errors.ts` | `AIGatewayError` hierarchy with stable codes and a `retryable` flag: `AI_NOT_CONFIGURED`, `AI_BUDGET_DISABLED` (configuration), `AI_BUDGET_EXCEEDED`, `AI_TIMEOUT`, `AI_UPSTREAM_ERROR`, `AI_OUTPUT_INVALID`. |
| `src/ai/provider.ts` | `AIProvider` contract (`name`, `configured`, `chat`) plus `OllamaCloudProvider` for `POST /api/chat` (non-streaming, `format: "json"`, request timeout, token usage from `prompt_eval_count` / `eval_count`). The API key is read server-side only. |
| `src/ai/models.ts` | Per-agent model resolution: `OLLAMA_MODEL_<AGENT>` → `OLLAMA_MODEL` → `Base 1-flash`. |
| `src/ai/agents.ts` | One spec per department/CEO agent: system brief, explicit JSON output contract and a Zod schema that mirrors the existing task output shape. Prompts forbid inventing metrics/sources/published posts and treat the goal text as untrusted data. |
| `src/ai/gateway.ts` | `generateStructured()`: configuration check, per-workspace daily budget (UTC day, `AI_MAX_DAILY_REQUESTS_PER_WORKSPACE`, falling back to `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE`, default 100, `0` disables), provider call, JSON extraction, Zod validation and `ai_request` audit usage (model, provider, latency, tokens, outcome, error code). `getAIStatus()` powers the status route. |
| `src/ai/agent-runtime.ts` | `runAgentTask()`: `AGENT_AI_MODE=auto` uses AI when configured, otherwise returns deterministic planner output explicitly marked `_meta.source = "deterministic_planner"`; `off` never calls AI; `required` throws `AIConfigurationError` instead of degrading. AI output carries `_meta = { source: "ai", provider, model, latencyMs, usage }`. |
| `src/orchestration.ts` | `processOrchestrationJob` now calls `runAgentTask` with the task timeout; AI errors are recorded on the task, and only gateway-retryable errors are retried. Configuration/budget failures stop the task instead of looping. |
| `src/index.ts` | `GET /api/ai/status` (authenticated, workspace-scoped): provider, configured flag, mode, agents + effective models, daily budget used/limit. No credentials. |
| `public/app.js` | Agent Control now shows an AI gateway panel (connected/not configured, provider, mode, requests today, per-agent model table, and what happens when unconfigured). |

Environment (documented in `.env.example`): `OLLAMA_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`,
`OLLAMA_MODEL_<AGENT>`, `AGENT_AI_MODE`, `AI_MAX_DAILY_REQUESTS_PER_WORKSPACE`.

## 2. Truth-first behaviour

- When no key is configured, agents do not pretend: task output is marked
  `_meta.source = "deterministic_planner"`, and the dashboard says AI is not configured.
- `AGENT_AI_MODE=required` makes a missing key fail the task (`AI_NOT_CONFIGURED`) and the run.
- Invalid JSON or a schema mismatch throws `AI_OUTPUT_INVALID`; no partially parsed answer is
  returned. Upstream 4xx/5xx and timeouts surface as `AI_UPSTREAM_ERROR` / `AI_TIMEOUT`.
- Publishing stays `planned_only` and video output is clip candidates only; the prompts forbid
  claiming that anything was published or rendered.

## 3. Verification (this session)

- `tsc --noEmit` PASS, `tsc -p tsconfig.json` (build) PASS, ESLint PASS.
- Vitest **33 files / 117 tests PASS**, including 14 new tests in `tests/ai-gateway.test.ts`:
  model resolution, mode/budget parsing, valid structured output + usage audit, non-JSON output,
  schema mismatch, budget enforcement (provider not called), unconfigured provider, deterministic
  fallback labelling, required-mode failure, per-agent model override, upstream error propagation,
  status route (401/200, no key leak) and an end-to-end orchestration failure when AI is required
  but not configured.
- Not verified automatically: a real Ollama Cloud call. `OLLAMA_API_KEY` is absent in this
  environment, so `generateStructured` against the real provider was not exercised (the provider
  transport and error mapping are covered only through injected fakes). Set the key, then run an
  orchestration and check `ai_request` audit events and the AI panel.

## 4. Next steps

1. Phase 24: drive orchestration from the engine (no driver in the HTTP request) with a durable
   driver lease.
2. Add a workspace-level per-agent model policy if operators need to change models without env
   changes.
3. Phase 25/26 remain blocked on media tooling/storage and platform developer credentials.
