# CELL-03 — MCP and MECE Control Center Verification

READ-ONLY. Inspect:
- .mece-control/server.mjs
- .mece-control/REPORT.md
- .mece-control/REPORT-MCP-CHAT.md
- .opencode/agents/
- .opencode/commands/
- OpenCode configuration, without printing secrets

Verify:
1. Which dashboard endpoints and tabs are implemented.
2. Whether MCP servers are actually connected or only configurable.
3. Whether MCP credentials are protected.
4. Whether agents are merely listed or have documented execution evidence.
5. Whether chat uses the local OpenCode server and what its cost implications are.
6. Whether automations are actually scheduled or only available as commands.
7. Whether localhost services expose unintended network interfaces.

Do not connect, disconnect, save or delete MCP servers.
Do not invoke paid models.
Do not modify files.
Write only .mece/cells/CELL-03/REPORT.md.
