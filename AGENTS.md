# AGENTS

UGC Affiliate Creator Clipping OS — standalone Fastify/TypeScript app. No CarryOS dependency.

- Stack: Node 22+, TypeScript strict (`NodeNext`), Fastify, Prisma 7, PostgreSQL, Vitest.
- Source: `src/index.ts`, modules `src/jobs.ts`, `src/orchestration.ts`, `src/workflows.ts`; shared libs `lib/`, Prisma schema `prisma/`.
- Generated Prisma client lives in `src/generated/prisma`; never edit. `npm install` runs `prisma generate`.

## Commands

These `.bin` entries may be non-executable in this Android/Termux environment; use Node entrypoints when needed.

- Format/types not configured separately.
- Lint: `node node_modules/eslint/bin/eslint.js .`
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- Build: `node node_modules/typescript/bin/tsc -p tsconfig.json && rm -rf dist/src/generated && cp -r src/generated dist/src/generated`
- Tests: `node node_modules/vitest/vitest.mjs run`
- Single test: `node node_modules/vitest/vitest.mjs run tests/<file>.test.ts`
- Full local check: `npm run check` (`typecheck && build && test`; may need Node invocation above in this environment)
- Dev server: `node node_modules/tsx/dist/cli.mjs watch src/index.ts`
- Migrate status: `node node_modules/prisma/build/index.js migrate status`
- Deploy migrations: `npm run db:migrate:deploy`

## Environment

Required: `DATABASE_URL`, `SESSION_JWT_SECRET` (32+ in production), optional `APP_ENV`, `CORS_ORIGIN`, `PORT`, `OLLAMA_API_KEY`, `TRUST_PROXY`, `MECE_DASHBOARD_TOKEN`, `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE`. `MECE_DASHBOARD_TOKEN` uses fail-closed 401 when absent or shorter than 32 characters; `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE` defaults to 100 and disables Ollama when `0`.
## Architecture and invariants

- Workspace auth: signup/login sets session cookie; requests use `X-Workspace-Id`. `requireAuthWorkspace` rejects missing/invalid membership.
- Data access uses `withWorkspaceTransaction(workspaceId, (tx) => ...)`, which sets audit `app.current_workspace_id` and enforces RLS for all workspace-scoped models.
- Never put secrets in frontend; Ollama key is read only in `src/ollama.ts`.
- API path unknown `/api/*` returns structured JSON 404.

## Testing notes

- Integration tests require PostgreSQL and valid `DATABASE_URL`/`SESSION_JWT_SECRET`.
- CI provisions a non-superuser `ugc_os_app` role; the local `u0_a304` superuser bypasses FORCE RLS, so `tests/workspace-isolation.test.ts` RLS assertion can fail locally even though application-level isolation passes.
- Ollama requests return `402` when the cloud account lacks credits; external billing decision, not an app bug.

## Change discipline

- Do not commit, push, deploy, or create secrets without explicit instruction.
- Preserve uncommitted user changes. Update `docs/autonomous-build/STATE.md` before wrapping up.
