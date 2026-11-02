# Architecture

## Components
- Dashboard `Agent Browser` view in `public/app.js`
- Browser gateway `src/browser-gateway.ts`
- Fastify API `/api/browser/*` and MCP endpoints in `src/index.ts`
- External runtime adapter in `src/browser-gateway.ts`
- Separate browser host requirement documented, not implemented in Termux

## Runtime decision
Variant A local Playwright/Chromium is impossible on Termux (`Unsupported platform: android`).

Variant B separate browser host is the only viable path to real browser functionality.

Variant C adapter pattern is already implemented and lets Variant B plug in through `BROWSER_RUNTIME_URL`.
