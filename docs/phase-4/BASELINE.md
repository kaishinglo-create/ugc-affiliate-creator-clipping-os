# Phase 4 Baseline

## State
- Branch: phase-4/production-readiness
- Stack: Node 24, TS, Fastify, Prisma 6, Postgres 16, Vitest.
- CI: green (run 40390994009 success) on main.
- Tests: 9 passing (health, auth x3, workspace isolation x5).
- Auth: bcrypt 12 rounds, JWT (jose), HttpOnly/SameSite cookie, rate limit 10/min on auth.
- RLS: Item FORCE RLS on workspaceId; tests pass as non-superuser.
- Gaps: no security headers, no graceful shutdown, no audit log table, no agent tables.
