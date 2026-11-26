# CI Reproducibility Report (Phase F.3.1)

## Scope

- Repository: kaishinglo-create/ugc-affiliate-creator-clipping-os
- PR: #28
- Branch: sync/remote-into-local
- Initial failed CI run: 45893968358 / job 140166155848
- Latest CI run: 45899331841 (status failure after fixes)

## Actions

- Added CI `API_INTEGRATIONS_MASTER_KEY` (valid Base64, 32 decoded bytes).
- Added CI `MECE_DASHBOARD_TOKEN`.
- Added root dependencies: `undici`, `@modelcontextprotocol/sdk`.
- Installed pilot dependencies: `npm --prefix pilots/api-anything ci`.
- Installed OpenCode CLI in CI.
- Fixed CI `.env` generation.
- Adjusted services doctor media health check.

## Reproducibility gate

- Local targeted regression set after fixes: PASS.
- Full local suite: 284/284 PASS.
- CI rerun after fixes: pending final re-check.

## Conclusion

- Status at time of report: **NOT_READY_TO_MERGE**.
- No merge, deployment, controller start or publishing performed.

## Final verification

- Final CI run: `45904295044`.
- Final CI head: `3887e5f65f82ab75b1dff11c7075f3c57add3289`.
- Final CI conclusion: **success**.
- Local full suite: 68 files, 284 tests PASS.
- Final status: **READY_TO_MERGE** pending explicit approval.
