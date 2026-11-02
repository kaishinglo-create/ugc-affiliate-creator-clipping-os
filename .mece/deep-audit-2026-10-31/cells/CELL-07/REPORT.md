# CELL-07 — Dependencies, Configuration, and Operations Audit

## Scope
Dependency/version posture, package scripts, environment config, build/runtime mechanics, and operation notes.

## Evidence
- `package.json`: Node `>=22.23.4`, TypeScript 5.6, Fastify 5, Prisma 7.10.1, Vitest 5.0.5.
- Built-in scripts `typecheck`, `lint`, `build`, `check`, `test`, `db:migrate:deploy` are appropriate.
- `.env.example` declares `SESSION_JWT_SECRET` as 32+ in production, `DATABASE_URL`, and optional Ollama key.
- Node version used: v26.12.1.
- `npm run typecheck`, `npm run lint`, `npm run build` expected/passed.
- No internet `npm audit` was run in this turn, so dependency actively exploitable status is unknown.

## Findings

### DEP-1 (MEDIUM) — Ollama key is mandatory secret configuration not surfaced in integrations
- File: `.env.example`, `src/integrations.ts`, `src/ollama.ts`
- Cause: secret server-only and not included in metadata registry.
- Confidence: High.

### DEP-2 (LOW) — Lint cleanliness issue count is 9
- Files: 8 orchestration/runtime variables and 1 unused shell variable in test.
- Cause: maintenance only; not type or runtime failure.
- Confidence: High.

### DEP-3 (LOW / operational) — Build copies generated Prisma client manually
- Scripts: `postinstall`, `build`.
- Cause: `dist/src/generated` replacement is part of documented command; CI must preserve exact build path.
- Confidence: High.

### DEP-4 (MEDIUM / environmental) — Production privilege handling
- Cause: DB RLS assumes a nonsuperuser, `NOSUPERUSER NOBYPASSRLS` app role. Local superuser runs can hide isolations.
- Needed: CI and development role parity.
- Confidence: High.

### DEP-5 (INFO) — Ollama 402 unavailable externally
- Cause: not an app code bug, but product capability depends on funded account or provider.
- Confidence: High.

## Recommendations
- Keep README/scripts operational validation up to date.
- Adjust lint warning budget policy if required for clean CI.
- Maintain non-super DB roles in all test environments.

## Blockers / limits
- Internet based audit commands not performed.
- Installed transitive dependency vulnerability scan not run due read-only/no network constraints.
