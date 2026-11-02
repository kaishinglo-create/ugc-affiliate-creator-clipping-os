# Security

- Browser URLs are validated and private/internal targets are blocked.
- Sessions and workspaces are checked by `requireAuthWorkspace`.
- MCP calls require workspace binding and permissions.
- Web page text is returned with an untrusted marker.
- No cookies or credentials are configured in frontend.
- Separate browser host must use token auth and no uncontrolled filesystem/network access.
