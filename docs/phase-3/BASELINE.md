# Phase 3 Baseline

## Repo state
- Stack: Node 22+, TypeScript, Fastify, Prisma 6, PostgreSQL, Vitest.
- Auth: signup/login/me, session JWT (jose), bcrypt.
- Workspace isolation: Membership required; Item CRUD scoped by workspaceId.
- RLS: Item table has FORCE RLS policy on workspaceId.
- Tests: 8 passing (health, auth, workspace isolation).
- CI: GitHub Actions billing-locked (account locked), so remote runs fail before starting. Local CI is used.

## CI failure
- Run 40384020435: "The job was not started because your account is locked due to a billing issue." Not a code failure.

## Gaps
- No rate limiting.
- No CORS config.
- No readiness DB check.
- No logout endpoint.
- No pagination/sorting.
- Error responses include Fastify defaults; need central handler.
- Membership RLS policy not yet defined (only Item).
- Tests for revoked/expired sessions missing.
