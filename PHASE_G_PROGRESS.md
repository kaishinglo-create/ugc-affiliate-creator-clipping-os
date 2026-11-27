# Phase G Progress

## G.0 Baseline audit

- Status: complete.
- Report: PHASE_G_BASELINE_AUDIT.md.
- Checkpoint: `77149bb`.

## G.1 Live content discovery

- Status: partial (YouTube Data API adapter, creator/keyword/trending routes, schedule enable/disable, scheduled cursor propagation).
- Files: `src/youtube.ts`, `src/discovery.ts`, `src/index.ts`, `tests/youtube.test.ts`.
- Tests: 3 files / 7 tests PASS.
- External blockers: no live `YOUTUBE_API_KEY`; browser-based discovery not yet wired.
- Next: browser-based permitted discovery, creator/keyword/trend persistence.

## G.2 AI research and content scoring

- Status: partial (explainable 10-dimension scoring module and API route).
- Files: `src/research-scoring.ts`, `src/index.ts`, `tests/research-scoring.test.ts`.
- Tests: 2 files / 6 tests PASS.
- External blockers: no live AI provider key; estimated dimensions are heuristics, not measured facts.
- Next: persist score reports and link to discovery candidates.

## G.3 Media ingestion

- Status: implemented locally.
- Files: `src/media-ingest.ts`, `src/index.ts`, `prisma/schema.prisma`, `prisma/migrations/20261127010000_phase_g_media_research_quality`, `tests/media-ingest.test.ts`.
- Models: `MediaSource`, `ResearchReport`, `QualityReport`.
- Features: authorized uploads, SHA-256 dedup, MIME validation, rights metadata, URL SSRF guard, ffprobe persistence, workspace RLS.
- Tests: 3 tests PASS.
- Migration applied locally and in QA DB.
- Next: persist research reports, quality reports and frontend wiring.

## Final state

- Full suite: 70 files, 290 tests PASS.
- No push, PR, merge, deployment, controller start or publishing.
- Final report: PHASE_G_FINAL_REPORT.md.

## Overall status

PHASE_G_PARTIAL
