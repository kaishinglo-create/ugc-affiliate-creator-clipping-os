# Security

- Browser URLs are validated to http/https only.
- Private, loopback, link-local, metadata, and non-public host patterns are blocked.
- URL credentials are rejected.
- Downloads are routed through the runtime only; no uncontrolled filesystem access is implemented.
- Web content is treated as untrusted; MCP calls require workspace/session/permission validation.
- Agent permissions are role allowlists; unknown roles receive status-only access.
- Human takeover can occur at any time and expires agent control.
- Control grants are time-limited and audit-logged.
- No real credentials or cookies are exposed by the implementation.
