# CELL-R4 — Ollama/API/Budget/Audit Report

## Changed files
- `src/index.ts`
- `tests/ollama-security.test.ts`

## Changes
- Fastify `trustProxy` is read deterministically from `TRUST_PROXY`.
- `/api/ollama/chat` now enforces configured workspace daily request limits (default 100 requests, configurable through `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE`; <=0 disables).
- Concurrency-safe PostgreSQL advisory lock (`hashtext`) protects count-and-insert evaluation.
- Kill-switch is checked before Ollama execution.
- Request body accepts only `prompt` or `message`; otherwise `INVALID_INPUT`.
- Upstream response status remains mapped; body remains discarded.
- Each request writes an audit event with outcome status, error class, model, prompt length; token/cost metadata is `not-supplied-by-provider`, not fabricated.
- Budget-exceeded outcomes return HTTP 429.
- Test budget config was added inherently through default.

## Validation
- Targeted `tests/ollama-security.test.ts`: 8/8 passed.
- Full non-superuser suite afterwards: 28 files / 79 tests passed.
