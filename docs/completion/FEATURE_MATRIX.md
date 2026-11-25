# FEATURE MATRIX (UGC Affiliate Creator Clipping OS)

| Funktion | Stand | Nachweis | Blocker |
|---|---|---|---|
| CEO-/COO-Agenten | Vollständig | src/company-agents.ts, src/orchestration.ts, tests/company-agents.test.ts, GET /api/orchestrations/:id/company-agents | — |
| Department-Agenten | Vollständig | src/orchestration.ts, src/ai/agent-runtime.ts, tests/deterministic-agent-output.test.ts | Deterministische Outputs gekennzeichnet |
| Agent Runtime | Vollständig | src/ai/agent-runtime.ts, src/ai/gateway.ts, tests/ai-gateway.test.ts | Live-Ollama-Call ohne Key nicht geprüft; Provider nur mit Fakes |
| MECE-Waves | Vollständig | .mece-control/server.mjs, scripts/services.sh, Browsercheck 27/27 | — |
| Browser Runtime | Vollständig (lokal) | browser-runtime-host/server.mjs, /api/browser/*, validateBrowserUrl mit DNS/IP-Prüfung | — |
| API Anything | Vollständig (Code) | src/mcp-client.ts, src/discovery.ts, tests/discovery-mcp-schedules.test.ts | Live-Smoke manuell |
| MCP | Teilweise | src/index.ts | Discovery-MCP nicht konfiguriert |
| Creator Discovery | Teilweise | src/discovery.ts, pilots/api-anything/server.mjs | Tier-1-Smoke scheiterte mit UND_ERR_HEADERS_OVERFLOW; kein Paid-Fallback |
| YouTube Discovery | Vollständig (Code) | src/discovery.ts, tests/discovery-cursor-retry.test.ts, tests/discovery.test.ts (`--`-Guard) | Live-Quelle nicht konfiguriert; Cursor/Retry gegen Fake-MCP geprüft |
| Affiliate Management | Vollständig | src/affiliate.ts, /api/affiliate/*, tests/affiliate.test.ts | Manuelle Erfassung; kein externes Netzwerk |
| Kampagnenmanagement | Vollständig (CRUD) | src/index.ts | — |
| Video Clipping | Vollständig (real) | ffmpeg/ffprobe 7.1.5, scripts/verify-media-runtime.ts, 720x1280 H.264/AAC, SSIM 0.930179, /api/media/extract-audio, /api/media/export | — |
| Transkription & Highlights | Vollständig (real) | whisper.cpp 1.9.6-dev + ggml-tiny.en.bin, echtes JFK-Transcript, SRT-Zeiten, tests/transcription.test.ts, /api/media/transcription/audio | — |
| Publishing | Teilweise (ehrlich) | src/publishing.ts, /api/publishing/jobs/*, Approval-Gate, Queue/Retry/Idempotenz/Audit, 409-Guard in generischen Job-Routen, tests/publishing.test.ts 7/7 | Keine Plattform-Credentials; NOT_CONFIGURED/CREDENTIALS_ONLY statt erfundener Uploads |
| Analytics | Vollständig (lokal) | src/analytics-sources.ts, GET /api/analytics/sources, tests/analytics-sources.test.ts 5/5, missing-Marker, getrennte Revenue-Quellen | Keine externen Analytics-Quellen |
| Multi-Account | Vollständig | lib/auth.ts, src/index.ts, ugc_os_app (rolsuper=f, rolbypassrls=f), tests/workspace-isolation.test.ts 5/5 | — |
| Self-Healing | Vollständig (read-only API) | src/self-healing.ts 14/14, GET /api/self-healing/proposals 1/1, echte Audit-Rows, nichts als `applied` markiert | Apply bleibt bewusst nicht über HTTP exponiert |
| Self-Improving | Vollständig | src/self-improving.ts, tests/self-improving.test.ts, GET /api/self-improving | Vorschläge nur beratend |
| Scheduler | Vollständig (Code) | src/engine.ts | Laufzustand abhängig von Cooldown |
| Service Doctor & Watchdog | Vollständig | scripts/services.sh doctor (JSON, keine Token-Werte), scripts/controller-watchdog.sh (SKIPPED_COOLDOWN), tests/services-doctor.test.ts 5/5 | Echter `--once`-Erfolg erst nach Cooldown-Ende |
| Security | Vollständig (lokal) | tests/jobs-approval-regression.test.ts, tests/redaction.test.ts, tests/static-file-hardening.test.ts, tests/trust-proxy.test.ts, tests/browser-ssrf-hardening.test.ts; F-01..F-10 geschlossen; Secret-Scan 0 Treffer | Produktions-Proxy/Credentials separat; kein Push/Deploy |
| Frontend | Vollständig | public/app.js, public/index.html, .mece-control/server.mjs, Browsercheck 27/27, Main-UI-Check 5/5 | — |
| Deployment | Blockiert | docs/release/PRODUCTION-ROADMAP.md | Keine Credentials; kein Push/Merge/Deploy |
| E2E-Tests | Vollständig | Vitest 225/225 (57 Dateien), Typecheck/ESLint/Build PASS, Browsercheck 27/27, Main-UI 5/5, Playwright 8/8, verify:media real grün | — |
