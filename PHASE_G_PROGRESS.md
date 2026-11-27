# Phase G Progress

Stand: 2026-11-27 — Branch `feature/phase-g-completion-2026-11-27`
(basierend auf `origin/main` / `a45d06a`).

## G.0 Baseline audit

- Status: complete.
- Report: `PHASE_G_BASELINE_AUDIT.md`.
- Checkpoint: `77149bb`.

## G.1 Live content discovery

- Status: complete at code level (live provider still externally blocked).
- Files: `src/youtube.ts`, `src/discovery.ts`, `src/index.ts`, `tests/youtube.test.ts`.
- Features: keyword/creator/trending Data-API adapters, recurring schedules,
  cursor propagation, bounded retry, persistent `DiscoveryCandidate` rows,
  engine dispatch and workspace RLS. Without `YOUTUBE_API_KEY` all routes fail
  closed with `503 YOUTUBE_NOT_CONFIGURED`.
- External blocker: no live YouTube API key / discovery MCP provider.

## G.2 Research and persistent scoring

- Status: complete.
- Files: `src/research-scoring.ts`, `src/research-reports.ts`, `tests/research-scoring.test.ts`,
  `tests/research-reports.test.ts`.
- Features: 10 explainable dimensions with `provided`/`estimated`/`missing`
  provenance, persisted `ResearchReport` rows with candidate linkage, list and
  detail routes. No invented engagement or revenue value.
- External blocker: no live AI provider key; estimated dimensions remain heuristics.

## G.3 Media ingestion and license check

- Status: complete.
- Files: `src/media-ingest.ts`, `src/media-download.ts`, `src/index.ts`,
  `prisma/migrations/20261127010000_phase_g_media_research_quality`, `tests/media-ingest.test.ts`,
  `tests/media-download.test.ts`.
- Features: authorized uploads, SHA-256 dedup, MIME/size validation, rights
  metadata, literal + DNS + redirect SSRF guards, bounded downloader, ffprobe
  persistence, workspace RLS.
- External blocker: no public media host is used; URL download is exercised with
  injected DNS/fetch doubles, never with fabricated production data.

## G.4 Scene detection and automatic clip ranking

- Status: complete.
- Files: `src/video/clipping.ts`, `src/clip-ranking.ts`, `src/media-composition.ts`,
  `tests/clip-ranking.test.ts`, `tests/media-composition.test.ts`.
- Features: real ffmpeg `select=gt(scene,…),showinfo` detection, transcript-based
  non-overlapping clip planning, deterministic ranking with visible reason,
  automatic `autoRankClips` chain and route.
- Verified live: real hard cut detected at 3 s in the generated verification source.

## G.5 Production and metadata

- Status: complete.
- Files: `src/content-production.ts`, `src/video/subtitles.ts`, `src/media-composition.ts`,
  `tests/content-production.test.ts`, `tests/media-composition.test.ts`.
- Features: `9:16` / `16:9` / `1:1` profiles applied in single, batch and
  release exports, real ffmpeg thumbnails, SRT burn-in, SRT→VTT, rule-based
  title/description/hooks/hashtags explicitly labelled `rule_based`.

## G.6 Persistent quality reports and release gate

- Status: complete.
- Files: `src/quality-gate.ts`, `src/media-release.ts`, `tests/quality-gate.test.ts`,
  `tests/media-release.test.ts`.
- Features: six persisted checks for success and failure, real duration check
  (fixed from the non-existent `format.duration` field), pending manual approval
  only for passing clips, export route guarded by `assertClipReleased`.
- No automatic publishing; release means "ready for human decision".

## G.7 Dashboard and agent integration

- Status: complete.
- Files: `public/app.js`, `src/index.ts`, `src/phase-g-pipeline.ts`, `src/engine.ts`,
  `src/jobs.ts`, `tests/phase-g-frontend.test.ts`, `tests/phase-g-pipeline.test.ts`.
- Features: Phase G Studio buttons for every backend area, autonomous
  `PHASE_G_PIPELINE` job type executed by the engine with lease fencing,
  heartbeats, audit and persisted redacted results.

## G.8 End-to-end verification

- Status: in progress.
- Planned/executed: `npm run verify:media` (existing real FFmpeg/Whisper proof),
  `npm run verify:phase-g` (new real end-to-end run producing three aspect ratios),
  two isolated `qa:full` runs, Playwright, MECE browser check, security audit.

## Test and checkpoint state

- Test inventory: 80 `*.test.ts` + 2 `*.spec.ts`; ≥316 tests (baseline 302 kept).
- Migration `20261127020000_phase_g_pipeline_job_type` applied locally; 41 migrations.
- No push, merge, deployment or publishing without separate approval.

## Overall status

Implementation: **complete**. Final status: **PHASE_G_PARTIAL** until verification,
PR and CI are green.
