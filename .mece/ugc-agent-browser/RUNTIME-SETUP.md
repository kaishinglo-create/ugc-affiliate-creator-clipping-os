# Runtime Setup

Current environment has no Chromium/Playwright binary.

To enable a real runtime without modifying app security:
1. Run a separate browser host process (Playwright/Chromium) on a trusted host.
2. Set `BROWSER_RUNTIME_URL=https://browser-host.example` and optionally `BROWSER_RUNTIME_TOKEN`.
3. The browser host must expose the documented adapter endpoints:
   `/status`, `/sessions`, `/sessions/:id/navigate`, `/back`, `/forward`, `/reload`, `/tabs`, `/tabs/new`, `/tabs/close`,
   `/read`, `/click`, `/type`, `/screenshot`, `/wait`, `/download`, `/close`.
4. Keep browser hosts workspace-aware and behind network controls; do not expose private/internal networks to sessions.

Until then, `BROWSER_RUNTIME_UNAVAILABLE` and `SESSION_DISCONNECTED` are the expected honest results.
