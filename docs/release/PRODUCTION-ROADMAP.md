# Production Roadmap

## Phase 18 — Release audit, branch integration, technical consistency
- Prereqs: repo access, main branch.
- Files: docs/release/PHASE-17-AUDIT.md, package.json, src/index.ts, tsconfig.json.
- Tasks: audit (done), fix start command (done), fix SPA path traversal (done), verify build/test (done).
- Tests: typecheck, lint, build, vitest, prisma migrate status.
- Acceptance: no critical/high blockers; docs committed.
- Status: DONE (local). Open risks: frontend demo-only.

## Phase 19 — Backend, DB, auth, persistence
- Prereqs: PostgreSQL 16, Node 22+.
- Files: lib/db.ts, lib/auth.ts, prisma/schema.prisma, migrations.
- Tasks: validate production config, enforce secrets, DB migrations reproducible, sessions expiry/revocation, workspace permissions.
- Tests: auth.test.ts, workspace-isolation.test.ts, health.
- Acceptance: `/ready` ok, auth flow works, isolation tests pass.
- Status: DONE (local). Open risks: no backup/restore automation.

## Phase 20 — Product features and external integrations
- Prereqs: provider credentials (optional).
- Files: src/integrations.ts, src/workflows.ts, public/app.js.
- Tasks: implement adapters or mark not_configured; honest status; no fake processing.
- Tests: integration tests (none yet for real providers).
- Acceptance: missing creds shown as not_configured; no fake metrics.
- Status: PARTIAL. Open risks: no real providers connected.

## Phase 21 — E2E QA, security, operability
- Prereqs: running app.
- Files: tests/*, docs.
- Tasks: add E2E for frontend flows, security headers review, mobile layout check, health checks.
- Tests: vitest (29), Playwright smoke (manual).
- Acceptance: no console errors, responsive layout verified.
- Status: PARTIAL. Open risks: no automated E2E in repo.

## Phase 22 — Production deployment and acceptance
- Prereqs: platform credentials, domain, secrets.
- Files: .env.example, docs/release/RELEASE-CHECKLIST.md.
- Tasks: choose platform, configure env, run migrations, deploy, verify URL/health, rollback plan.
- Tests: post-deploy smoke.
- Acceptance: live URL verified, health ok, rollback documented.
- Status: BLOCKED (no deployment credentials/platform decision).
