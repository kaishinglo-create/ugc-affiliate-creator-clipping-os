# Master Roadmap

## Phases A–F.4

Status: complete and merged into `main` (Phase F.4 integration commit `3ce5004`).

## Phase G

Status: **implementation complete, final verification in progress** (`PHASE_G_PARTIAL`
until both isolated QA runs, the real-media verification, PR and CI are green).

Merged into `main` (merge commit `a45d06a`, PRs #29/#30/#31):

- G.0 baseline audit complete.
- G.1 YouTube discovery adapter, schedules, cursor/retry and persistent candidates.
- G.2 explainable 10-dimension research scoring.
- G.3 persistent media ingestion with rights, SHA-256, MIME and SSRF guards.
- G.4 scene detection and deterministic clip ranking.
- G.5 production profiles, VTT, thumbnails and rule-based copy.
- G.6 persistent quality reports (including the fixed real-duration check).
- G.7 Phase G Studio frontend wiring.

Completed on `feature/phase-g-completion-2026-11-27` (not yet merged):

- Persistent, workspace-scoped research reports (`ResearchReport`), persisted from
  `POST /api/discovery/score` with candidate linkage and detail/list routes.
- Bounded URL media downloader with DNS- and redirect-level SSRF validation.
- Real ffmpeg thumbnails, SRT→VTT route and automatic
  detect-scenes → plan → rank chain.
- Manual clip-release gate: passing persisted quality report plus explicit
  approval before `POST /api/media/releases/:id/export`.
- Production profiles (`9:16`, `16:9`, `1:1`) honoured in single and batch export.
- Autonomous `PHASE_G_PIPELINE` job executed by the engine, covering probe,
  transcription, scene detection, ranking, export, thumbnail, copy, quality and
  pending release; wired into the dashboard.
- 14 new regression tests; full suite ≥316 tests / 82 files.

Open verification steps: real-media pipeline run, two isolated `qa:full` runs,
Playwright, MECE browser check, security audit, PR and CI.

## Phase H

Status: prepared, not started. Publishing queue and approval gate already exist.
