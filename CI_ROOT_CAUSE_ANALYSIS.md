# CI Root Cause Analysis (Phase F.3.1)

## Initial CI failure (job 140166155848)

- Failed: `npm run check`.
- Local baseline: 284 tests / 68 files PASS.
- CI result: 264 PASS, 14 FAIL, 2 SKIPPED, 280 executed (68 files).

## Observed failures

1. `tests/discovery-headers.test.ts`
   - Root cause: missing `undici` package in root install context while importing `pilots/api-anything/server.mjs`.

2. `tests/api-integrations-*.test.ts` / related service checks
   - Root cause: missing or invalid `API_INTEGRATIONS_MASTER_KEY`; fail-closed behavior returned `503 CREDENTIAL_STORE_NOT_CONFIGURED`.
   - Rate-limit failures were downstream consequences because credential setup failed.

3. `tests/api-integrations-isolation.test.ts`
   - Root cause: `credentialSource` was `none` because the master key / environment credential setup was unavailable.

4. `tests/services-doctor.test.ts`
   - Root cause: environment-dependent media health; local runner had ffmpeg/whisper, CI did not.

5. `tests/mece-runtime.test.ts`
   - Root cause: missing CI runtime prerequisites (MECE token and OpenCode runtime).

6. Test-count delta
   - CI executed 280 tests; 2 skipped; local full suite 284 tests. The skipped count was environment-related, not reduced by local changes.

## Fixes applied

- Added valid Base64 AES-256 master key for CI (`API_INTEGRATIONS_MASTER_KEY`).
- Added `MECE_DASHBOARD_TOKEN` for CI.
- Added `undici` and `@modelcontextprotocol/sdk` to root dependencies and installed pilot dependencies via `npm --prefix pilots/api-anything ci`.
- Installed OpenCode CLI in CI.
- Added CI test `.env` without indentation issues.
- Adjusted services doctor media health logic for optional media prerequisites.

## Status

- Local targeted reruns after fixes: 30 tests across affected integration/doctor/discovery files PASS.
- Full local suite after Phase F was 284/284 PASS.
- Full CI rerun required after fixes before final sign-off.
