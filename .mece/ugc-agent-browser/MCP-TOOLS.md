# MCP Tools

Endpoint: `/api/browser/mcp` (JSON-RPC 2.0 `tools/list`, `tools/call`), plus `/api/browser/mcp/tools`.

Required tools:
browser_open, browser_navigate, browser_back, browser_forward, browser_reload, browser_tabs, browser_new_tab, browser_close_tab, browser_read, browser_click, browser_type, browser_screenshot, browser_wait, browser_download, browser_session_status, browser_request_control, browser_release_control.

Each call requires a workspace-bound session and is subject to agent permission checks.
