# Merge Conflict Report (Phase F.1)

## Conflicts observed

### `origin/feat/discovery-schedule` (`4da26dd`, PR #27)

Conflicting files:

- `prisma/schema.prisma`
- `src/engine.ts`
- `src/index.ts`
- `docs/autonomous-build/STATE.md`
- `pilots/api-anything/README.md`

Root cause:

- Remote implements one recurring schedule per workspace with `DiscoverySchedule.workspaceId` as primary key.
- Local already implements recurring discovery with a different `DiscoverySchedule` model using `id` as primary key and `workspaceId` as foreign key, plus `lastRunAt`, timestamps and an index.
- Remote adds `/api/discovery/schedule` routes and engine enqueue behavior that overlap with local discovery routes and tests.

Resolution plan:

- Do not overwrite either implementation.
- Design a single additive schema migration or unify the model before integration.
- Re-run `tests/discovery.test.ts` and `tests/discovery-mcp-schedules.test.ts`.

### `origin/phase-16/release-verification` (`63ab78b`)

Conflicting files:

- `prisma/schema.prisma`
- `src/index.ts`

Root cause:

- Remote install-check changes were already present locally through Phase F, so the commit was skipped.

### `origin/local/audit-untracked-2026-11-02`

Potential conflicts:

- `src/index.ts`
- `src/orchestration.ts`
- Additive runtime files (`.mece/*`, `browser-runtime-host/cdp-server.mjs`, `src/scheduler.ts`)

Resolution plan:

- Review scheduler lease, heartbeat, retry, deduplication and crash recovery against local orchestration leases before integrating.
- Avoid duplicate worker/scheduler/browser runtimes.

## Additive migration strategy

- Do not modify already applied migrations.
- Use new additive correction migrations where schema unification is required.
- Test both fresh databases and upgrades of existing databases.