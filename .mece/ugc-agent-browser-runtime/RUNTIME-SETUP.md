# Runtime Setup

## Termux feasibility result
`npm install playwright` succeeds, but `playwright install chromium` fails with `Unsupported platform: android`.

## External browser host setup
1. Provision a trusted host with Node.js, Playwright, and Chromium.
2. Run an HTTP browser adapter exposing:
   `/status`, `/sessions`, `/sessions/:id/navigate`, `/back`, `/forward`, `/reload`, `/tabs`, `/tabs/new`, `/tabs/close`, `/read`, `/click`, `/type`, `/screenshot`, `/wait`, `/download`, `/close`
3. Set in UGC app env:
   - `BROWSER_RUNTIME_URL=https://<browser-host>`
   - `BROWSER_RUNTIME_TOKEN=<shared token>`
4. Start UGC app. `/api/browser/status` must report `available: true`.

No real runtime is available until step 4 succeeds.
