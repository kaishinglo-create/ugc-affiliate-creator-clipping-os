# CELL-01 — Security and Authentication Audit

Audit ID: DEEP-AUDIT-2026-10-31

## Scope
Authentication, session handling, authorization, workspace membership, security headers/error surfaces, and operator console boundaries. Files reviewed: `lib/auth.ts`, relevant route handlers in `src/index.ts`, `src/security` references, `src/mcp`/`.mece-control` behavior, security tests.

## Evidence
Commands and observed outcomes:
- `git branch --show-current` → `main`.
- `git status --short` showed 12 tracked modified files and several untracked audit/artifact directories.
- `npm run lint` (`node node_modules/eslint/bin/eslint.js .`) → exit 0, 9 warnings.
- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm test` on a temporary non-superuser database → `28 files passed / 79 tests passed` (TEST_EXIT=0).
- No database migrations were deployed to the user's runtime PostgreSQL. Temporary `ugc_os_test` only.

## Findings

### SEC-01 (MEDIUM) — Local MECE control center has no application authentication
- Unique ID: DA-C01-SEC-01
- Area: `.mece-control/server.mjs`
- Cause: Dashboard binds to `127.0.0.1:3031` and OpenCode to `127.0.0.1:4096`; Origin/IP checks are the primary access gate, but no login/session layer is visible for `/api/run`, configuration, chat, and MCP operations.
- Scenario: A local process or browser context that reaches loopback and satisfies origin rules can operate the console and run OpenCode automation.
- Mitigation present: loopback binding, origin validation, manual run opt-ins.
- Missing: strong per-operator auth, path/automation allowlists, backup cleanup.
- Confidence: Medium. Source binding was verified; host network exposure was not audited.

### SEC-02 (MEDIUM) — Control-center backups may retain secrets
- File: `.mece-control/server.mjs` via `mergeMcpProject`/backup behavior.
- Cause: timestamped `.bak` OpenCode configuration copies are generated before MCP saves; secret values may exist in those backups.
- Missing: retention policy, redacted backup format, explicit cleanup path. Secret values were not inspected in this audit.
- Confidence: Medium-high (documented behavior).

### SEC-03 (LOW / static risk) — Symlink/path containment and path-file access remain test-scope risks
- File references: `src/index.ts` (`serveFile`), release/additional security findings.
- Cause/proof status: A null-byte path guard was added to `serveFile`, but a broader filesystem containment and deep-link SPA behavior proof is not present in this wave.
- Confidence: Medium. Static evidence only in referenced code/tests; not newly exercised.

### SEC-04 (LOW) — Roles are not strongly differentiated for Ollama
- File: `src/index.ts` Ollama route.
- Cause: any workspace member can trigger server-side Ollama spend; budget attribution/kill switch are absent.
- Confidence: High.

### SEC-05 (LOW) — API error strings propagate directly to frontend
- File: `public/app.js`, messages from `/api/*`.
- Cause: toasts show backend `error` verbatim.
- Impact: administrative detail disclosure at application level, not a critical exposure.
- Confidence: Medium.

## Reproduction
- Not applicable for findings that are static policy risks. `ECONN`/path probes were not run due read-only scope.
- Sec-01/Sec-02 repros require altering control-center configuration, which was explicitly prohibited.

## Recommendations (no repair in this wave)
- Harden `.mece-control` with local/operator auth, path allowlists, and backup retention/cleanup.
- Continue route-level `requireAuthWorkspace`, secure cookies matching `APP_ENV`/`NODE_ENV`, and RLS enforcement.
- Make untrusted-path and deep-link behavior explicit in tests.

## Blockers / limits
- No internet/provider exploitation performed.
- No attempts to bypass auth using crafted tokens/users were executed in this audit pack.
