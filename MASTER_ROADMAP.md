# Master Roadmap

## Phases A–F (complete)

- A–F.4: local implementation, consolidation, CI repair and final merge completed.
- PR #28 merged into `main` as `3ce5004748ca1d6759a377276179f966af4cacc9`.
- Main integration final status: **MAIN_INTEGRATION_COMPLETE**.

## Phase F.1 – Repository consolidation

- Local Phase F committed as `061c391`; integration branch `sync/remote-into-local` created.
- Remote commits processed: `ddcaf72` integrated, `63ab78b` skipped (already present), `4da26dd` replaced by local implementation, `c229333` CDP fallback integrated, `3f77552` excluded (duplicate scheduler), `d32c378` documentation consolidated.

## Phase F.2 – QA

- QA reports created; 284 tests baseline; two isolated `qa:full` runs passed.

## Phase F.3 / F.3.1 / F.3.2 – GitHub synchronization and CI repair

- PR #28 published; CI reproducibility fixed; merge conflicts resolved.
- Final PR state before merge: MERGEABLE/CLEAN; CI green.

## Phase F.4 – Final main integration

- PR #28 merged into `main`; local and remote main SHA identical.
- Final report: `PHASE_F4_FINAL_INTEGRATION_REPORT.md`.

## Phase G – Live Discovery, AI Analysis & Video Clipping

- G.0 Baseline audit: complete (`PHASE_G_BASELINE_AUDIT.md`).
- G.1 Live discovery: code complete (`src/youtube.ts`, schedules, browser/API pilot wiring).
- G.2 Research scoring: complete (`src/research-scoring.ts`, `src/research-reports.ts`).
- G.3 Media ingestion: complete (`src/media-ingest.ts`, `src/media-download.ts`, rights/checksum/SSRF/RLS).
- G.4 Intelligent clipping: complete (`src/video/clipping.ts`, `src/clip-ranking.ts`, `src/media-composition.ts`).
- G.5 Content production: complete (`src/content-production.ts`, VTT, thumbnails, profiles).
- G.6 Quality/approval: complete (`src/quality-gate.ts`, `src/media-release.ts`).
- G.7 Frontend/agents: complete (`public/app.js`, `src/phase-g-pipeline.ts`, engine integration).
- G.8 Local E2E: complete — real FFmpeg/Whisper verification, three aspect profiles, two isolated `qa:full` runs (81 files / 327 tests each, watchdog not triggered), Playwright **9/9**, reproducible MECE browser check **27/27**, frontend tab acceptance **19/19**, CDP smoke.
- Final acceptance report: `PHASE_G_FINAL_ACCEPTANCE_REPORT.md`; GitHub report: `GITHUB_INTEGRATION_REPORT.md`.
- PR #32 merged regularly into `main` as `45cacf5502783cfbd8f634f2d8dc7c52c8a84375` (2026-11-27T05:35:54Z); local `main` fast-forwarded and identical to `origin/main`. Post-merge CI `45946760934` green; isolated regression on `main` 327/327 tests, 81/81 files. Report: `PHASE_G_MAIN_INTEGRATION_REPORT.md`.
- Final status: **PHASE_G_MAIN_INTEGRATION_COMPLETE** (locally implemented, locally verified, integrated in `main`); **PHASE_G_LIVE_VERIFICATION_PENDING** for external live verification (credentials still blocked).

## Phase H – Live Publishing and Affiliate Tracking

- Final status: **READY_FOR_COMMIT** — H.0–H.8 complete, 353/353 tests in 87
  files, two isolated `qa:full` runs on frozen source, Playwright 9/9,
  MECE 30/30, frontend 23/23, real media pipeline PASS, secret scan 0 matches.
  Report: `PHASE_H_FINAL_ACCEPTANCE_REPORT.md`.
- Official Phase-H development approval received 2026-11-27. Branch
  `feature/phase-h-live-publishing-2026-11-27`, baseline `main`
  `55d28c4e210fcbe9b9877fda090cf796ade8c280`; all changes remain **uncommitted**.
  Work packages H.0–H.8 are tracked in `PHASE_H_TASKS.json`; master prompt in
  `docs/autonomous-build/PHASE_H_MASTERPROMPT.md`. Recovery audit:
  `PHASE_H_RECOVERY_AUDIT.md`; MECE matrix: `PHASE_H_FEATURE_MATRIX.md`.
- H.0 complete: four full audits before implementation; no duplicate queue —
  `Job(category=PUBLISHING)` remains the durable queue.
- H.1 implemented: `PublishingAccount`/`PublishingSchedule` models with RLS,
  IANA-timezone plans, idempotency, retry/backoff, DLQ, crash recovery,
  circuit-breaker reads, daily attempt cap, kill-switch preflight and audit.
- H.2 implemented: official YouTube/TikTok/Instagram adapters behind encrypted
  workspace credentials and `PUBLISHING_LIVE_ADAPTERS`; Shorts/Reels formats,
  progress checkpoints, token-refresh persistence, no fake uploads and no
  `CONNECTED` without a real probe. Without credentials: `NOT_CONFIGURED`.
- H.3 implemented: SHA-256 checksum → approval request → explicit human decision
  → versioned v2 binding (clip/checksum/account/parameters) → queue → authorized
  upload → confirmation → audit. Changes invalidate the approval; expiry and
  revocation are re-checked before upload/retry. Unknown upload outcomes are
  non-retryable and require manual reconciliation.
- H.4 implemented: affiliate links with UTM/disclosure, signed server-side
  webhooks, click/conversion dedup, real `commissionCents` only, payout
  persistence and truth-first revenue per clip/creator/platform/campaign/UTM.
  Missing commissions stay `null`/`—`.
- H.5 implemented as read panels plus write actions (accounts, approvals,
  schedules, links, retry, revoke, disable) in the existing `calendar`,
  `agents`, `analytics` and `campaigns` views; no new tab. All `h5-*` panels also
  render with explicit missing markers in a fresh workspace. `LOCAL_IMPLEMENTED`,
  `LOCAL_VERIFIED` and `EXTERNAL_LIVE_VERIFIED: NONE` are shown separately.
- H.6: typecheck, ESLint, build, 327 baseline tests plus 26 new Phase-H tests
  (353 total in 87 files) are green. Two isolated `qa:full` runs on the
  identical frozen stand each passed 353/353; Playwright 9/9, frontend
  acceptance 23/23, MECE browser check 30/30, `verify:phase-g` passed, DB
  verification 7/7 and secret scan (4 values, 520 files, 0 matches) are
  documented in `PHASE_H_FINAL_ACCEPTANCE_REPORT.md`.
- External live verification remains blocked (`EXTERNAL_LIVE_VERIFIED: none`):
  no platform credentials/OAuth app approvals, no `YOUTUBE_API_KEY`, no
  `OLLAMA_API_KEY`, no public host, no deployment credentials and no real
  affiliate-network signature scheme. Controller/Supervisor remain `stopped`.
- No commit, push, PR, merge, deployment, controller restart or real upload has
  been performed. Final status: `PHASE_H_READY_FOR_COMMIT` (awaiting explicit
  commit approval).

## Phase H – Main-Integration (2026-11-28)

- PR #33 gemergt als Merge-Commit `5c4104595d0e23e1fefbd3bc352f532e855d712f`;
  lokales und entferntes `main` identisch. Post-Merge-CI `46086634835` SUCCESS.
- 354/354 Tests in 87 Dateien, 43+ Migrationen; vollständig vorbereitete
  Phase-I-Dokumentation. Nachweis: `PHASE_H_MAIN_INTEGRATION_REPORT.md`.
- Status: **PHASE_H_MAIN_INTEGRATION_COMPLETE**,
  **PHASE_H_EXTERNAL_LIVE_VERIFICATION_PENDING**.

## Phase I – Self-Healing and Self-Improving

- Implementierung abgeschlossen: 362/362 Tests in 88 Dateien, zwei isolierte
  `qa:full`-Läufe grün, Browser-Gates 9/9/30/30/23/23, Secret-Scan 0 Treffer.
  Status: **PHASE_I_READY_FOR_COMMIT**; Abschlussbericht
  `PHASE_I_FINAL_ACCEPTANCE_REPORT.md`.
- **PHASE_I_READY_TO_START** (Vorbereitungsstand) — vollständig vorbereitet, nicht implementiert.
  Masterprompt `PHASE_I_MASTERPROMPT.md`, Aufgaben `PHASE_I_TASKS.json`,
  Architekturen und Abnahmekriterien unter `docs/autonomous-build/`.
  Reale Phase-G/H-Zwischenfälle INC-PH-01..06 sind die Startfälle.

## Phase J – Autonomous 24/7 operation

- Planned, not started.

## Phase K – Production acceptance

- Planned, not started.
