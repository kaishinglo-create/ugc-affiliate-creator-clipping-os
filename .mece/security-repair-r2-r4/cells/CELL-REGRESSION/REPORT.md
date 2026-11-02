# CELL-REGRESSION — Final Regression Report

## Executed
- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
- `node node_modules/eslint/bin/eslint.js .` → exit 0 (9 warnings only).
- `node node_modules/typescript/bin/tsc -p tsconfig.json && rm -rf dist/src/generated && cp -r src/generated dist/src/generated` → exit 0.
- `node node_modules/vitest/vitest.mjs run` against temporary non-superuser role `ugc_os_app` / database `ugc_os_test` → exit 0, 28 files passed, 79 tests passed.
- `node --check .mece-control/server.mjs` → passed.

## Result
- No newly introduced type or lint errors.
- All prior 79 tests still pass after model config, R2, R3, R4.
- Control-center syntax passed.
- Ollama security test: 8/8 passed.
- Job security tests: 14 passed.
- Browser/E2E: not run (blocked).
EOF