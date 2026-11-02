# CELL-R2 — Control-Center Hardening Report

## Changed files
- `.mece-control/server.mjs`

## Changes
- Enforced loopback/origin checks plus dashboard token authentication for every `/api/` path.
- Dashboard token is read from `MECE_DASHBOARD_TOKEN` with constant-time comparison.
- Token must be at least 32 characters; missing/invalid tokens reject.
- Support Bearer or `X-Control-Token`.
- Added `dashboardAuthEnabled` to bootstrap status.
- `crypto` import, helper functions and startup warning added to protected mode.
- Did not delete historical `.bak` files or expose secret values.

## Validation
- Node syntax check passed: `node --check .mece-control/server.mjs`.

## Validation constraints
- No broad live browser matrix or authenticated control-center functional tests were executed.
- Existing workflows require an externally supplied `MECE_DASHBOARD_TOKEN` of sufficient length.
