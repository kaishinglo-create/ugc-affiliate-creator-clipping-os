# DEEP AUDIT TEST RESULTS

Audit ID: DEEP-AUDIT-2026-10-31

## Executed commands

1. Git status / branch
   - `git rev-parse --abbrev-ref HEAD` → `main`, exit 0.
   - `git status --short` → nonclean, exit 0.
   - `git log --oneline -8` → completed.

2. Typecheck
   - Command: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
   - Exit code: 0
   - Result: pass.

3. Lint
   - Command: `node node_modules/eslint/bin/eslint.js .`
   - Exit code: 0
   - Result: pass, 9 warnings.
   - Warnings are only unused variables; 0 errors.

4. Build
   - Command: `node node_modules/typescript/bin/tsc -p tsconfig.json && rm -rf dist/src/generated && cp -r src/generated dist/src/generated`
   - Exit code: 0
   - Result: pass.

5. Full non-superuser suite
   - DB: temporary `ugc_os_test`
   - Role: temporary `ugc_os_app` (`NOSUPERUSER NOBYPASSRLS`)
   - `DATABASE_URL` temporary, `SESSION_JWT_SECRET` temporary, no production credential.
   - Command: `node node_modules/vitest/vitest.mjs run`
   - Exit code: 0
   - Result: 28 test files passed, 79 tests passed.
   - Side-effect: server runtime logs show expected mocked Ollama statuses and idempotency conflict behavior.

6. Migration static RLS proof
   - Temporary PostgreSQL command:
     `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='Job';`
   - Result: `t / t`
   - Policy query: one `Job_workspace_isolation` policy.
   - Exit: 0.

7. Prior frontend smoke
   - `tests/frontend-smoke.test.ts` included in full run; 6 passing as recorded baseline (full suite passes).

8. Workspace-isolation RLS caveat
   - Local superuser cannot prove force RLS; non-super run covers nonsuper checks.
   - Superuser-run override `tests/workspace-isolation` may be less meaningful due role bypass.
   - Concurrency tests passed under nonsuper user.

## Blocked or unavailable
- `npm audit` / deep internet dependency scan not run (network constraints/read-only choice).
- Browser/interactive E2E blocked (no Playwright evidence).
- Successful live Ollama model call blocked by upstream 402 credit availability.
- Secret backup sweep impossible without violating read-only/security scope.

## False positives/not re-tested
- Prior reports mention styling/hardening; current warnings count is now 9.
- Platform security nuances from older audits remain static-only.
