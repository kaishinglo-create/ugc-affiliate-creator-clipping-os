# UGC OS Architecture (Current Verified State)

- `src/index.ts`: Fastify API/UI host; auth, workspaces, jobs, workflows, orchestration, browser gateway, kill switch, security endpoints.
- `src/jobs.ts`: transactional job queue with claims, leases, heartbeats, retries, dead-letter, recovery.
- `src/scheduler.ts`: opt-in persistent scheduler with advisory leader lock, bounded concurrency, graceful shutdown, status.
- `src/orchestration.ts`: departments, agent definitions, dependency-aware task DAG, budget reservations, approval waits.
- `src/browser-gateway.ts`: browser sessions, control leasing, permissions, HTTP runtime adapter.
- `browser-runtime-host/cdp-server.mjs`: CDP fallback host without Playwright.
- `lib/db.ts`: Prisma PostgreSQL adapter and workspace transaction helpers.
- `prisma/`: schema and 43 migrations.
- Frontend assets under `public/`.
