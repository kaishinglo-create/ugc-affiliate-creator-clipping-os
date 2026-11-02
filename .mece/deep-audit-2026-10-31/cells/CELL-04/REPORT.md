# CELL-04 — Frontend and Browser Security Audit

## Scope
SPA shell delivery, auth/JWT UI behavior, form handling, XSS hygiene, user error handling, and compatibility tests.

## Evidence
- `public/app.js`, `tests/frontend-smoke.test.ts`.
- Frontend smoke: 6 tests / all pass (baseline).
- `public/app.js` defines `esc()` and uses it in numerous template branches.
- `api()` uses fetch credentials and `X-Workspace-Id`.
- No executable browser tests / no visual inspection.

## Findings

### FE-01 (LOW) — Frontend smoke coverage is thin
- File: `tests/frontend-smoke.test.ts`
- Cause: only six endpoint/load checks; no interactive form or mobile-width checks.
- Confidence: High.

### FE-02 (LOW) — Inconsistent input parsing and error handling
- File: `public/app.js`
- Cause: `Object.fromEntries(new FormData(...))`, direct error messaging; validation is mostly server-side.
- Scenario: malformed inputs are transmitted to backend for final rejection.
- Confidence: High.

### FE-03 (LOW) — API errors are displayed verbatim
- File: `public/app.js`
- Cause: backend `error` values used in toasts/messages; possibility of internal string disclosure.
- Confidence: High.

### FE-04 (INFO) — LocalStorage stores non-secret workspace id
- File: `public/app.js`
- Cause: only `ugc_workspaceId` is stored in localStorage, not a JWT token. Fine for current design.
- Confidence: High.

### FE-05 (MEDIUM / blocked) — No live browser/responsive E2E verification
- Cause: no Playwright execution allowed/read-only; no screenshot or DOM error evidence.
- Confidence: High that this is a proof gap.

### FE-06 (LOW) — Frontend double `analytics` branch
- File: `public/app.js`
- Cause: switch includes analytics case twice; only last meaningful assignment survives. Maintainability risk.
- Confidence: High.

## Reproduction
No interactive tests were performed against UI forms or responsive displays; per go-live posture browser automation was blocked.

## Recommendations (no repair)
- Add focused browser tests for auth and workspace switching.
- Add layout regression checks for mobile widths.
- Keep `esc()` mandatory in templates.

## Blockers / limits
- No CSP, Trusted Types, mobile evidence.
- No screenshot or visual correctness proof.
