# Consolidated Feature Matrix (Phase F.1)

| Function | Local | GitHub main | Remote branch / PR | Difference | Remaining work |
|---|---|---|---|---|---|
| Core architecture | Implemented | Implemented | Older phase branches | Local ahead | Keep local |
| Discovery worker | Implemented | Implemented | Older | Local ahead | Keep local |
| Recurring discovery | Implemented locally (id-based schedule) | Missing | PR #27 (workspaceId-based schedule) | Conflicting designs | Unify schema/routes/tests |
| Persistent scheduler | Missing | Missing | `local/audit-untracked` | Remote only | Compatibility review |
| CDP browser fallback | Missing | Missing | `local/audit-untracked` | Remote only | Compatibility review |
| RLS migration guard | Integrated | Base | `phase-16/release-verification` | Remote guard added | Done in integration branch |
| Security F-01 to F-10 | Implemented | Missing | Older security branches | Local only | Preserve and push after QA |
| Whisper / FFmpeg | Verified | Older | Older | Local ahead | Keep local |
| Publishing | Implemented | Missing | None | Local only | Keep local |
| Affiliate analytics | Implemented | Missing | None | Local only | Keep local |
| Self-healing | Partial | Missing | None | Local only | Keep local |
| Company agents | Implemented | Older | None | Local ahead | Keep local |
| Isolated QA runtime | Implemented | Missing | None | Local only | Keep local |
| API Integration Center | Completed in Phase F | Missing | None | Local only | Keep local |
| Credential vault | Completed in Phase F | Missing | None | Local only | Keep local |