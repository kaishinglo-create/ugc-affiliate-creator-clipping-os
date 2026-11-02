# CELL-05 — Jobs, Orchestration, and Automation Audit

## Scope
Persistent job lifecycle, claim/retry/fence logic, orchestration runtime, scheduling, and automation entry points.

## Evidence
- `src/jobs.ts`, `src/orchestration.ts`, job/migration tracks.
- Existing assertions:
  - `jobs-hardening`: concurrency, stale claim rejection.
  - `jobs-workspace-scope`: cross-workspace `getJob`, `claimJobById`, mutation guards.
  - Runtime fixtures and orchestration cases pass.
- Full non-superuser suite 28/79 passed.
- Migration creates indexes and unique scoped idempotency law.

## Findings

### JOB-01 (MEDIUM) — Helper workspace parameters remain optional
- File: `src/jobs.ts`
- Cause: `workspaceId` in `JobActionOptions` and other inputs can be omitted.
- Risk: runtime helpers require caller discipline; future code could accidentally unscope updates.
- Confidence: High.

### JOB-02 (MEDIUM) — initial global primary-key reads can be unscoped with superusers
- File: `src/jobs.ts` fallback paths.
- Cause: if workspace option absent, primary-key read ignores `current_workspace_id`.
- Mitigation: under non-superuser RLS no rows; mutation clauses include workspace.
- Confidence: High.

### JOB-03 (LOW) — Automation and scheduler are user-driven/manual
- File: `.mece-control/server.mjs`, scheduler APIs
- Cause: no internal continuous scheduler in dashboard; `/api/run` manually starts OpenCode automation.
- Risk: operator-driven, not scheduled; still high authority.
- Confidence: High.

### JOB-04 (MEDIUM) — orchestration concurrency and DB writes rely on transaction context
- File: `src/orchestration.ts`
- Cause: approve/reject and task progress updates need strict transaction composition.
- Evidence: run passed both superuser and nonsuper suites.
- Confidence: Medium-high.

### JOB-05 (LOW) — Historical release test expected old warning count
- File: test/reference reports.
- Cause: prior docs mention 8 warnings, now 9 due tests/jobs-workspace-scope.
- Confidence: High.

## Reproduction
`npm test` against temporary test database (TEST_EXIT=0) with 28 files/79 tests; code review of lease/timestamp clauses and transition map.

## Recommendations
- Enforce workspace helpers at public signature boundary.
- Add concurrency contract test under non-superuser with repeated operations.
- Document orchestration scheduler control process.

## Blockers / limits
- No extensive fault-injection or chaotic network tests.
- No production-scale concurrency benchmark available.
