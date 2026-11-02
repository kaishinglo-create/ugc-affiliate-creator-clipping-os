# REPAIR PLAN

Audit ID: DEEP-AUDIT-2026-10-31

## Priorisierte Reparaturvorschläge

R1 (HIGH / commercial dependency)
- Option: fund Ollama Cloud or add/additionally verify alternate provider
- Impact: unblocks live model responses
- Validation: integration test with mock no longer needed; live health and content extraction test, plus status propagation.

R2 (HIGH / operator authority)
- Add auth/device-trust to `.mece-control`.
- Add path allowlists, backup retention/cleanup, and authenticated automation execution.
- Validation: E2E security tests and control-center smoke.

R3 (MEDIUM / tenant hardening)
- Make job workspace parameters mandatory in typed signatures.
- Convert all direct data reads/writes in helpers to transactional scoped access.
- Validate `TEST_EXIT` consistency and negative cross-workspace cases.

R4 (MEDIUM / API and provider metadata)
- Add Ollama integration registry entry (or virtual provider key) in `src/integrations.ts`.
- Add server-side spend/budget enforcement and audited attribution.
- Validate proper `trustProxy` behavior.

R5 (MEDIUM / request validation)
- Introduce strict Zod/message body schema and integration key handling.
- Suggested validation error 400 paths integrated in route tests.
- Regression: `tests/ollama-security.test.ts` and `tests/integrations.test.ts`.

R6 (MEDIUM / browser proof)
- Add Playwright or at least tests for submission, responsive important screens, and workspace selection.
- Confirm CSP/security headers and SPA 404 expected behavior.

R7 (LOW / maintenance/environment)
- Cleanup lint warnings; CI rate should use non-superuser; preserve build command as documented.
- Retain temporary test role internally or CI only, not production.

## No-repair rule
This phase audited only; repairs are listed and not started.
