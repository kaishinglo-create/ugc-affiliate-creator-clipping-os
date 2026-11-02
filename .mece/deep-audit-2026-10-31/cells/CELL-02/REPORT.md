# CELL-02 — Workspace Isolation, Database, and RLS Audit

Audit ID: DEEP-AUDIT-2026-10-31

## Scope
Workspace transaction scoping, membership, table-level RLS, migration changes, and Job workspace isolation.

## Evidence
- `prisma/migrations/20261029000000_phase19_job_runtime/migration.sql` initially created `Job` without RLS.
- Added migration `prisma/migrations/20261101000000_phase20_job_workspace_rls/migration.sql` enables and forces RLS and defines policy `Job_workspace_isolation`.
- PostgreSQL test database `ugc_os_test` with role `ugc_os_app` (`NOSUPERUSER NOBYPASSRLS`) confirms:
  - `Job.relrowsecurity = true`
  - `Job.relforcerowsecurity = true`
  - policy row count = 1.
- Code review: workers use `withWorkspaceTransaction`; helper reads use requested workspace where available.
- Full non-superuser suite: 28 files / 79 tests passed.

## Findings

### DB-01 (MEDIUM) — RLS correctness depends on transaction context
- Unique ID: DA-C02-DB-01
- Cause: every row policy checks `current_setting('app.current_workspace_id')` after `withWorkspaceTransaction`.
- Scenario: A future helper using global `prisma` and a primary-key read may receive no rows under non-superuser execution even if ownership would be valid, or may silently bypass policy when using superuser credentials.
- Missing: mandatory workspace helper signatures, wrappers for every cross-workspace data read.
- Confidence: High.

### DB-02 (MEDIUM) — Superuser venues bypass policy in local verification
- Cause: local PostgreSQL user `u0_a304` is superuser and bypasses force RLS.
- Severity/environmental; production role discipline (non-superuser) mitigates.
- Confidence: High.

### DB-03 (MEDIUM) — Helper scope still optional
- Optional `workspaceId` in `JobActionOptions`, `FailJobInput`, `RequeueOptions`, and ClaimJobs options.
- Guards reject mismatch, but untrusted/forgetful callers may omit scope.
- Confidence: High.

### DB-04 (LOW) — `getJob` fallback can be unscoped in superuser context
- File: `src/jobs.ts getJob`.
- Cause: when no workspace ID is provided, `findUnique({ where: { id } })` resolves row directly.
- Under non-superuser policy it returns no row; under superuser or in test context it is less safe.
- Confidence: High.

### DB-05 (INFO) — Cross-workspace tests pass in import/memory workflow
- `tests/workspace-isolation.test.ts` and `tests/jobs-workspace-scope.test.ts` passed in nonsuper run, evidencing workspace separation.
- Confidence: Medium-high for test range; database size small.

## Reproduction
- Run final non-superuser suite against `ugc_os_test` (TEST_EXIT=0) and inspect `Job` policy flags.
- These artifacts are documented in test results; no new mutation against runtime DB.

## Recommendations (no repair)
- Make helper workspace parameters mandatory at public boundaries.
- Add RLS per table audit tool/check list and run under non-superuser in CI.
- Keep migrations additive and nongenerative in production.

## Blockers / limits
- No production database migration executed.
- Temporary DB/schema were local only.
- Live admin-role capabilities beyond row policy were not hostile-tested.
