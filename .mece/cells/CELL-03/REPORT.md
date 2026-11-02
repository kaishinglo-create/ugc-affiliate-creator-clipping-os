# CELL-03 — MCP and MECE Control Center Verification

## Scope
Read-only verification of the MECE Control Center (`.mece-control/server.mjs`), its persisted reports, OpenCode agent/command definitions, OpenCode configuration references, and repository state. MCP servers, OpenCode connections, configurations, and model calls were not changed. The previous `CELL-03/REPORT.md` was incorrectly scoped as a routing/security audit and has been replaced by this MCP/control-center report.

## Acknowledgement of uncommitted changes
The repository contains uncommitted modifications and untracked files. They were not altered, reverted, or committed. This audit references those changes but did not verify them with destructive actions. Key relevant untracked area: `.mece-control/`, `.opencode/`, `.mece/`.

## Commands and checks used
- Static inspection of `.mece-control/server.mjs` (957 lines), reports, agent/command files.
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0 (conductor).
- `node node_modules/eslint/bin/eslint.js .` → 0 errors, 9 warnings, with `.mece-control/**` ignored by configuration.
- Production build → exit 0 (conductor).
- `node node_modules/vitest/vitest.mjs run tests/health.test.ts tests/frontend-smoke.test.ts` → 2 files, 7/7 tests passed.
- No POST requests to MCP save/delete/test, no config save, no `opencode mcp add/remove`, no chat message calls, and no paid model calls were made in this cell.
- `grep`/source inspection was used for binding addresses and endpoint definitions.

## Environment and implementation facts
- Dashboard server: `http://127.0.0.1:3031`, bound with `server.listen(PORT, "127.0.0.1", ...)`.
- App server observed as `http://127.0.0.1:3000` (separate process).
- OpenCode HTTP server is spawned as `opencode serve --hostname=127.0.0.1 --port=4096`, then proxied via dashboard endpoints.
- OpenCode CLI version reported by prior control-center reports: 1.19.5.
- Default agent/model reported as `orchestrator` / `ollama-cloud/beam`.
- Seven agent definitions exist under `.opencode/agents`; commands exist under `.opencode/commands`.
- MCP list is read from project and global OpenCode configuration. At the time of the control-center reports, no MCP servers were configured.
- Control-center settings/automation runs can execute `opencode` against the repository; these are user-started manual actions, not automatic or scheduled.

## Verified implemented dashboard surface
Tabs and major pages:
- Agents (`GET /api/agents`, agent markdown loaded)
- Automations (`GET /api/automations`, command markdown loaded)
- MCP Connector (`GET /api/mcp`, save/test/delete endpoints)
- Chat (`/api/chat/state`, sessions, messages, prompt, abort)
- Runs (`/api/status`, `/api/log`, run history)
- Settings (`/api/config`, `/api/run`)

Endpoints implemented in source:
- Static HTML: `GET /`
- `GET /api/bootstrap` and `GET /api/status`
- `GET /api/config`, `POST /api/config`
- `POST /api/run`
- `GET /api/log`
- `GET /api/agents`
- `GET /api/automations`
- `GET /api/mcp`, `POST /api/mcp/save`, `POST /api/mcp/delete`, `POST /api/mcp/test`
- `GET /api/chat/state`, `GET /api/chat/sessions`, `POST /api/chat/session/create`, `GET /api/chat/messages`, `POST /api/chat/message`, `POST /api/chat/abort`

Mutation endpoints require an allowed local origin via `isAllowedOrigin`, which permits requests with no Origin or local origin on the dashboard port. Combined with `127.0.0.1` binding, exposure is localhost-only.

## Verified findings

### 1. MCP servers are configurable, with no configured server at audit time
- `readMcpConfig()` aggregates MCP entries from `.opencode/opencode.json` and `~/.config/opencode/opencode.jsonc` but returns empty if none are configured.
- `.mece-control/REPORT.md` states initial `GET /api/bootstrap.mcp = 0` and `GET /api/mcp` returned an empty list. `.mece-control/REPORT-MCP-CHAT.md` records MCP validation and save/delete testing with cleanup.
- `POST /api/mcp/save` validates name, transport, URL, required local command, env/header object shape, input size, and requires explicit confirmation before activation.
- `mergeMcpProject()` backs up project config before writing, creating a timestamped `.bak` copy under `.mece-control/runs` and writing backup note, so historical secrets may exist in backups if previously configured.
- MCP is therefore a configuration connector, not a currently active/connected integration baseline. No server is connected by default.

### 2. MCP and control-center secret handling
- Dashboard responses return server metadata only, with `hasSecrets` rather than secret values. Evidence: `readMcpConfig()` sets `hasSecrets` based on key presence only.
- Error output is passed through `redact()` before response; env variables and headers are stored in OpenCode configuration and may be plaintext in OpenCode config and backups.
- MCP save requires user confirmation before enabling, and invalid names/missing command return 400.
- OpenCode config save serializes credentials exactly as entered when provided; form behavior described in control-center report prevents displaying existing secret values, but filled form data can replace them.
- Credentials are not printed in this audit.

### 3. Agents are listed and have documented execution evidence
- `.opencode/agents/*.md` files are loaded dynamically into dashboard agent cards, including description, mode, permission, task text, and prompt.
- There are 7 agent definions reported (`frontend-auditor`, `api-auditor`, `security-auditor`, `repair-agent`, `regression-agent`, `synthesis-agent`, `orchestrator`).
- `.mece-control/REPORT-MCP-CHAT.md` documents an actual OpenCode chat response `OK` from a session using `ollama-cloud/beam`, so at least one real agent/model invocation was verified in the control-center report.
- In this Wave 04 cell, no agent automation or paid model call was invoked.
- Agent definitions include documented responsibilities, but not all individual cells require evidence output on disk; actual repair execution during MECE waves is context-dependent.

### 4. Chat uses the local OpenCode server and has cost implications
- Dashboard `/api/chat/state` starts or reports `http://127.0.0.1:4096`, and sessions/messages are proxied through the local OpenCode process.
- Message sending invokes `client.session.prompt`, which uses the selected agent and configured model (`ollama-cloud/beam` by default). The control-center report explicitly notes this is cost-relevant for manual use.
- Chat accepts a max 10,000-character message and rejects empty or too-large input.
- No paid calls are started automatically at dashboard startup; sessions are created and messages sent only on explicit user action.
- Success and error responses are proxied; redacted error details are returned, but message content is stored in OpenCode sessions and returned in the dashboard.

### 5. Automations are commands, not schedules
- `.opencode/commands/*.md` files provide automation prompts (`mece-audit`, `mece-repair`, `mece-regression`, `mece-wave`).
- `/api/run` spawns `opencode` with the chosen automation prompt against the project directory and streams output to a run log; it has a 300-second timeout and stores status/history.
- The `scheduler/run`, `runtime/status`, and queue endpoints in the primary UGC app are separate; in the control center, automation execution is manual, from the dashboard.
- There is no evidence of a continuously scheduled timer in `.mece-control/server.mjs`; runs must be launched by the user or an API call.

### 6. localhost network exposure assessment
- Dashboard HTTP bind is explicitly `127.0.0.1:3031`.
- OpenCode server bind is explicitly `127.0.0.1:4096`.
- The primary UGC app config is separate; the dashboard reads `appServerUrl` as a string and does not proxy app API by default. Default reported app URL is `http://127.0.0.1:3000`.
- Origin check on mutation/chat endpoints permits only no-origin or localhost-origin calls; browser-origin spoofing risk is reduced by binding and same-host policy.
- No exact production exposure claim can be made from static inspection alone (for example, host firewall or overlay network); but source-level binding is loopback-only.
- Shell command execution endpoint is gated by localhost origin and only runs OpenCode/`opencode mcp list`, but `/api/run` itself takes user-supplied project path, automation name, agent, model, and prompt from stored settings and validates project directory existence and allowed automation names.

### 7. MCP test and execution boundaries
- `POST /api/mcp/test` calls `describeMcpStatus()`, which runs `opencode mcp list` server-side and redacts password-like text in output. It does not invoke a configured MCP tool.
- This provides status only, not an end-to-end MCP tool execution test.
- No connect/disconnect/save/delete MCP action was performed in this Wave 04 cell.

### 8. Data storage and backup caveats
- Project settings are stored in plain JSON at `.mece-control/config.json`; no secrets are expected there by default.
- MCP secrets/headers may exist in OpenCode's project/global config and backups. Control-center backup notes are minimal (`Backup erstellt...`) and offer a path only, not secret redaction.
- Run history and log references are stored under `.mece-control/runs`.
- MCP config empty state behavior returns `{"servers":[]}`, preserving a clear baseline.

## Open risks
1. MCP entries with real secrets could exist in `.opencode/opencode.json`, global config, historical `.bak` files, or `.mece-control/runs/*backup*`; this audit did not inspect their values.
2. Control center is an operator console with code execution (`/api/run`) and config mutation; anyone able to reach loopback or spoof browser-origin rules, plus a valid local session flow, could be affected. No auth layer beyond Origin/IP guarantees was observed in `.mece-control/server.mjs`.
3. `.mece-control` is ignored by project ESLint, so the dashboard's JavaScript correctness is not covered by the app lint command. It is custom runtime code with high operational authority.
4. `backupFileIfNeeded()` stores full historical OpenCode config in `.bak*` files and a backup-note file is always written when a save happens; cleanup/retention is not implemented in source.
5. Chat and run workflows can trigger paid model usage (`ollama-cloud/beam`) when invoked manually, and model billing is outside app budget controls.
6. Agent definitions are loaded from disk and can be changed outside Git/version control; no signature or permission audit ensures their integrity.
7. Error paths in some dashboard endpoints call `redact`, but OpenCode/log parsing or stack traces may include host-specific data; MCP `opencode mcp list` output truncates at 12,000 characters.
8. Control center settings allow changing project path to any existing directory and prompt text; validation does not sandbox paths or use an allowlist.

## Blockers and limitations
- Read-only mandate prevented any MCP operation, config save, chat session creation, automation run, or dashboard mutation in this cell.
- No connectivity or smoke test was run against the dashboard because the mandate prohibits actions beyond simple read-only checks; prior control-center reports performed such tests before this wave.
- Network exposure conclusion is based solely on source binding; host OS/network configuration was not audited.
- Secret values were not inspected or disclosed; only system behavior was reviewed.
- This report does not independently prove agent code quality or command execution success during the current wave.

## Confidence
- High for endpoint/tab inventory and source-level binding/gate evidence.
- Medium for historical MCP/secret state, because no interactive or connectivity tests were repeated and backups were not inspected.
- Medium-high for chat/MCP credential and model-cost behavior, based on prior control-center reports plus current source.
- Overall confidence: medium-high.

---

## Wave 04.1 hardening update
- Independent API, migration, and helper behavior was verified with `npm run typecheck`, production build, and full Vitest suite.
- Command: `node node_modules/vitest/vitest.mjs run` → 28 test files, 79 passed.
- Same suite was rerun with a temporary non-superuser PostgreSQL role (`ugc_os_app`) against disposable database `ugc_os_test`; result: 28 test files, 79 passed.
- Additional targeted non-superuser runs passed for jobs, jobs hardening, Ollama security, workspace isolation, Ollama, orchestration, orchestration recovery, and orchestration runtime files.
