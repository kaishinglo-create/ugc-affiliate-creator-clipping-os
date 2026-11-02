# Architecture

- Frontend: `public/app.js`, `public/index.html` -> `Agent Browser` view and workspace-bound API calls.
- Gateway: `src/browser-gateway.ts` owns in-memory sessions, tabs, controller state, permission checks, SSRF guard, audit events, and runtime delegation.
- Runtime: `createBrowserRuntimeFromEnv()` returns an external HTTP adapter when `BROWSER_RUNTIME_URL` is set; otherwise an unavailable adapter that reports honestly.
- MCP: Fastify endpoints `/api/browser/mcp/tools` and `/api/browser/mcp` expose the required browser tool names and invoke gateway methods.
- Persistence: browser sessions are process-local; audit events use the existing workspace-scoped audit writer.
- Workspace isolation: every gateway operation requires `workspaceId` and a workspace-scoped session lookup plus membership auth via `requireAuthWorkspace`.
