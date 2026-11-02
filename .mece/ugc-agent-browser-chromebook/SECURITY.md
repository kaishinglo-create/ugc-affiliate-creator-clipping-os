# Security

- Host port must stay on a private LAN.
- Token auth is required.
- Browser runs an isolated Playwright context, not the user's Chrome profile.
- No cookies/secrets are logged or reported.
- SSRF protections remain in the UGC gateway before host invocation.
- Prompt injection is handled by marking web content untrusted.
