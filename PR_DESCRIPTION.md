# Pull Request: Phase F.1/F.2 Repository Consolidation

## Summary

Consolidates local Phase F work with selected remote commits on `sync/remote-into-local`.

## QA Evidence

- Direct Vitest: 68 files, 284 tests PASS
- `npm run qa:full`: 2 successful runs (exit code 0)
- Typecheck: PASS
- ESLint: PASS
- Build: PASS

## Remote Commit Decisions

- `ddcaf72`: integrated (RLS guard)
- `63ab78b`: skipped (already present)
- `4da26dd` (PR #27): replaced by local recurring discovery implementation
- `c229333`: CDP fallback integrated
- `3f77552`: excluded to avoid duplicate scheduler
- `d32c378`: documentation consolidated

## Notes

PR #27 is functionally superseded by the local recurring discovery implementation and should not be merged blindly.