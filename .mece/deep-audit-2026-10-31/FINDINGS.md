# DEEP AUDIT FINDINGS

Audit ID: DEEP-AUDIT-2026-10-31

## CRITICAL
None currently verified as CRITICAL in the audited code path.

## HIGH
1. DA-C03-API-01 — External Ollama Cloud requires credits/payment and blocks successful response. File/lines: `src/ollama.ts 1-62`, `src/index.ts /api/ollama route`; mock pathways verified, live data path blocked. Severity HIGH (external commercial blocker).

## MEDIUM
1. DA-C01-SEC-01 — no application authentication in control center. File: `.mece-control/server.mjs`; loopback/origin gate only.
2. DA-C02-DB-01 — tenant isolation depends on `app.current_workspace_id` transaction scoping. File: `lib/db.ts`, broad DB patterns.
3. DA-C02-DB-02 — local superuser role bypasses RLS. Environment-specific; production role needed.
4. DA-C02-DB-03 — optional workspace scopes in job/public helper signatures. Files: `src/jobs.ts` interfaces; route callers now forward IDs.
5. DA-C03-API-02 — Ollama omitted from integration metadata. File: `src/integrations.ts 1-25`.
6. DA-C03-API-03 — Ollama lacks budget/spend/quota controls.
7. DA-C03-API-04 — Unstrict request body schema and string coercion.
8. DA-C03-API-07 — API health generally depends on tx discipline.
9. DA-C01-SEC-02 — historical backups may preserve secrets.
10. FE-05 — no browser/responsive E2E proof.
11. DB/JOB-01 through JOB-04 — optional signatures and concurrency test limitations.
12. MCP-01 — no control center dashboard auth.
13. MCP-02 / DEP-3 — backup retention and scanner limitations.

## LOW
1. FE-01 — thin frontend smoke coverage.
2. FE-02 — basic form validation and error rendering.
3. FE-03 — API error verbatim toast.
4. FE-06 — duplicate analytics branch.
5. SEC-03 — symlink/path containment (static untested).
6. SEC-04 — broad member auth for Ollama spend.
7. SEC-05 — error string user disclosure.
8. API-05 — `trustProxy` assumption.
9. API-06 — unknown non-GET API path behavior.
10. DB-04 — `getJob` no-workspace fallback.
11. JOB-05 — warning count documentation mismatch.
12. MCP-03/MCP-04 — plaintext storage and limited MCP testing.
13. DEP-2 — 9 lint warnings.
14. API metadata concurrency notes.

## INFO
- FE-04 — localStorage stores non-secret workspace id only.
- DEP-5 — external upstream credit.
- REG-04 — warnings.
- No critical exploit or direct secret leak was verified.

## Confidence
- Source/static understanding: high.
- Test behavior: high locally.
- Live external provider behavior: low due 402.
- Browser/host exposure: medium-low.
