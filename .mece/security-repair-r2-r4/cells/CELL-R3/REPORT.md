# CELL-R3 — Mandatory Job Workspace Boundaries Report

## Changed files
- `src/jobs.ts`
- `tests/jobs.test.ts`
- `tests/jobs-hardening.test.ts`
- `tests/jobs-workspace-scope.test.ts`

## Changes
- `JobActionOptions.workspaceId`, `RequeueOptions.workspaceId`, and `HeartbeatOptions.workspaceId` are required in option types.
- `getJob` and `claimJobById` now require their scope argument/field.
- `failJob` accepts workspace from `opts.workspaceId` and falls back to `input.workspaceId`, then rejects missing scope.
- `getJob`, `claimJobById`, and mutation `readJob` calls return `null` when no valid workspace scope exists.
- Existing mutation where clauses and transactional read-back behavior remain workspace-scoped.
- Updated test calls to pass workspace identities.

## Validation
- TypeScript passed: `tsc --noEmit`.
- `tests/jobs.test.ts`, `tests/jobs-hardening.test.ts`, `tests/jobs-workspace-scope.test.ts` passed in non-superuser test run.
