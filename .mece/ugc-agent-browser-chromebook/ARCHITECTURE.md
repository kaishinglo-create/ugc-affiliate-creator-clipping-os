# Architecture

- Termux: UGC app, dashboard, gateway, agents.
- Chromebook: external Chromium/Playwright HTTP runtime only.
- Existing UGC adapter uses `BROWSER_RUNTIME_URL` and `BROWSER_RUNTIME_TOKEN`.
- The host must not expose the UGC app's private internals; only controlled browser commands are exposed.
