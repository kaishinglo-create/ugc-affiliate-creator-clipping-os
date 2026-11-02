# CELL-01 — Workspace Security and Job Lifecycle Verification

## Scope
Read-only verification of workspace scoping in the job runtime and approval mutations. Inspected `src/jobs.ts`, job/approval routes in `src/index.ts`, `lib/db.ts`, `lib/auth.ts`, `tests/security.test.ts`, `tests/workspace-isolation.test.ts`, relevant Prisma migrations, and current git status/diff. No product source, tests, configuration, or database state were modified. Uncommitted working-tree changes were preserved.

## Acknowledgement of uncommitted changes
The repository has uncommitted modifications and untracked files. They were treated as the code under audit and were not reverted, committed, or altered.

## Commands and checks used
- `git status --short` / `git diff`: verified repository state without changing it.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`: exit 0.
- `node node_modules/eslint/bin/eslint.js .`: 0 errors, 9 warnings (`.mece-control/**` ignored; one warning is in the new workspace-scope test).
- Production build command: exit 0, including generated Prisma client copy.
- `node node_modules/vitest/vitest.mjs run tests/health.test.ts tests/frontend-smoke.test.ts`: 2 files, 7/7 tests passed.
- Static source and migration inspection.
- Database-mutating tests (`tests/security.test.ts`, `tests/workspace-isolation.test.ts`) were inspected only, not executed.

## Verified facts

### 1. Workspace authentication and transaction context
- Job/approval/orchestration/scheduler routes call `requireAuthWorkspace` before processing. Evidence: `src/index.ts` routes around `/api/jobs*`, `/api/approvals*`, `/api/orchestrations*`.
- `requireAuthWorkspace` validates session, workspace ID format, and workspace membership. Evidence: `src/index.ts: 129-140`, `lib/auth.ts:74-78`.
- `withWorkspaceTransaction` validates the workspace ID shape and sets transaction-local `app.current_workspace_id`. Evidence: `lib/db.ts:16-25`.
- `getJob` now accepts an optional workspace argument; with it, lookup is `findFirst({ where: { id, workspaceId } })`. Without it, the helper falls back to primary-key lookup. Evidence: `src/jobs.ts:getJob`.
- Scoped runtime queries (`getJobs`, `getJobRuntimeStatus`, `claimDueJobs`) enforce `workspaceId` in Prisma/SQL predicates. Evidence: `src/jobs.ts:getJobs`, `getJobRuntimeStatus`, `claimDueJobs`.

### 2. Job lifecycle scope inventory after uncommitted repairs
| Function | Initial read | Mutation predicate | Assessment |
|---|---|---|---|
| `createJob` | workspace tx | `workspaceId` set from caller | Scoped |
| `getJobs` / `listJobs` | scoped tx query | `workspaceId` in `where` | Scoped |
| `getJob` | primary-key read unless workspace supplied | no mutation | Library helper; routes add ownership check |
| `claimDueJobs` | scoped tx | raw SQL uses `k."workspaceId" = ${workspaceId}` | Scoped |
| `heartbeatJob` | primary-key read | `id`, `workspaceId: job.workspaceId`, status, lease, owner, expiry | Mutation partially scoped |
| `completeJob` | primary-key read | includes `workspaceId: job.workspaceId` | Mutation partially scoped |
| `failJob` | primary-key read | both retry/terminal paths include `workspaceId: job.workspaceId` | Mutation partially scoped |
| `cancelJob` | primary-key read | includes `workspaceId: job.workspaceId` | Mutation partially scoped |
| `markWaitingForApproval` | primary-key read | includes `workspaceId: job.workspaceId` | Mutation partially scoped |
| `resumeAfterApproval` | primary-key read | includes `workspaceId: job.workspaceId` plus status | Mutation partially scoped |
| `rejectJob` | primary-key read | optional `opts.workspaceId` guard; update uses `job.workspaceId` | Partially scoped |
| `requeueDeadLetterJob` | primary-key read | update uses `job.workspaceId`; optional `opts.workspaceId` guard | Partially scoped |
| `resumeJob` | primary-key read | delegates to requeue/resume helpers | Inherited partial scope |
| `claimJobById` | primary-key read | asserts optional workspace, then uses `workspaceId: job.workspaceId` in update | Partially scoped |
| `getJobRuntimeStatus` | scoped tx | all predicates include `workspaceId` | Scoped |

### 3. Lease and worker predicates
- `leaseMatches` verifies both supplied `leaseId` and `workerId`. Evidence: `src/jobs.ts:118-124`.
- `heartbeatJob` rejects stale leases using `leaseId`, `leaseOwner`, and `leaseExpiresAt >= now`; on fence failure it returns the current row rather than updating. Evidence higher in source.
- `completeJob`, `failJob`, `cancelJob`, and `markWaitingForApproval` compare `updateMany.count` with `1` and return the latest row when the fenced update does not match.
- `claimDueJobs` only claims eligible queued/retry jobs with ordering, `FOR UPDATE SKIP LOCKED`, and lease writes.
- The transition matrix is intact (`QUEUED`, `RUNNING`, etc). Evidence: `src/jobs.ts:125-138`.

### 4. Approval mutations
- Approval list and create routes use `workspaceId` in query/create data within `withWorkspaceTransaction`. Evidence: `src/index.ts:468-483`.
- Decision route uses `updateMany({ where: { id, workspaceId: ctx.workspaceId } })`, checks `result.count`, and returns 404 on mismatch. Evidence: `src/index.ts:484-498`.
- Orchestration approval decisions run in `withWorkspaceTransaction`, update approval and matching task rows, then update the linked Job with workspace-scoped predicates. Evidence: `src/orchestration.ts:598-625`.
- Approval visibility/update correctness depends on RLS for `Approval`; linked job mutation is additionally fenced by `job.workspaceId`.

### 5. RLS behavior and local superuser limitation
- No RLS policy or `ENABLE/FORCE` statement exists for `Job`. Evidence: all migration SQL files; phase-19 `Job` migration creates the table without RLS.
- `Approval`, `OrchestrationRun`, `OrchestrationTask`, and later tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with `workspaceId = current_workspace_id()` policies. Evidence: migrations under `20261026..._rls` and `20261030000000_phase20_firm_hierarchy`.
- `FORCE ROW LEVEL SECURITY` does not apply to PostgreSQL superusers. Local `u0_a304` / CI guidance in `AGENTS.md` documents this; CI uses `ugc_os_app` as `NOSUPERUSER NOBYPASSRLS`. Evidence: `AGENTS.md` testing notes, `tests/workspace-isolation.test.ts`.
- The workspace-isolation RLS assertion can fail under a local superuser role even when application-level isolation passes.

## Remaining unscoped or partially scoped access paths
1. `getJob`, `rejectJob`, `requeueDeadLetterJob`, `resumeJob`, and `claimJobById` read by global primary key and use global `prisma` for initial reads. Routes perform ownership checks afterward, but library callers can bypass them.
2. Optional guards (`opts.workspaceId`) added to `rejectJob`, `requeueDeadLetterJob`, and `claimJobById` are not mandatory.
3. `heartbeatJob`, `completeJob`, `failJob`, `cancelJob`, `markWaitingForApproval`, and `resumeAfterApproval` fetch status by primary key before the fenced update; the mutation where clause adds `workspaceId`, but the read is not transactional.
4. `Job` has no RLS policy, so its isolation remains application-level.
5. Approval and orchestration behavior depends on transaction-local `app.current_workspace_id` being set through `withWorkspaceTransaction`.

## Open risks
- A trusted caller or new route using `getJob`, `rejectJob`, `requeueDeadLetterJob`, `resumeJob`, or `claimJobById` without workspace arguments can cross workspace boundaries.
- `Job` has no database-level tenant isolation.
- Route ownership checks occur after the helper-level primary-key read, leaving a theoretical race window that is only mitigated by fenced `workspaceId` updates, not DB constraints.
- `rejectJob` and `requeueDeadLetterJob` are callable with only an ID by any code that imports them.
- RLS cannot be proven locally under a superuser DB role.

## Assumptions (not verified)
- Production job mutations originate through authenticated routes that verify `job.workspaceId === ctx.workspaceId`.
- CI uses the non-superuser role described in `AGENTS.md`; this pass did not connect to the database.
- Scheduler, resumes, and claim-by-id operations use row IDs derived from an allowed workspace, though helper signatures cannot prove it.
- The uncommitted repairs were produced elsewhere and were only verified in this pass; they were not independently exercised by database tests.
- No adversarial cross-workspace mutation was attempted.

## Blockers and limitations
- Database-mutating integration tests were intentionally not executed; no runtime security assertion was re-run.
- No HTTP/browser checks were performed for job routes.
- Conclusions are based on static source, migration inspection, and safe type/build/lint/smoke checks.
- No secrets were read, printed, or exported.

## Confidence
Medium-high for route-level workspace ownership and lease predicates; medium for helper-level isolation because initial reads are unscoped, optional guards are not mandatory, and `Job` has no RLS.

---

## Wave 04.1 hardening update
- Added `prisma/migrations/20261101000000_phase20_job_workspace_rls/migration.sql` with `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and `Job_workspace_isolation` policy.
- `Job` RLS validated in temporary PostgreSQL `ugc_os_test` as non-superuser role `ugc_os_app`: `relrowsecurity=true`, `relforcerowsecurity=true`, and policy present.
- No migration was deployed against the user's runtime database; all migration testing used a temporary disposable database.
