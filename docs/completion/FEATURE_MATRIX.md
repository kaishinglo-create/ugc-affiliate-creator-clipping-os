# FEATURE MATRIX (UGC Affiliate Creator Clipping OS)

| Funktion | Stand | Nachweis | Blocker |
|---|---|---|---|
| CEO-/COO-Agenten | Vollständig | src/company-agents.ts, src/orchestration.ts, tests/company-agents.test.ts, GET /api/orchestrations/:id/company-agents | — |
| Department-Agenten | Vollständig | src/orchestration.ts, src/ai/agent-runtime.ts, tests/deterministic-agent-output.test.ts | Deterministische Outputs gekennzeichnet |
| Agent Runtime | Vollständig | src/ai/agent-runtime.ts, src/ai/gateway.ts, tests/ai-gateway.test.ts | Live-Ollama-Call ungetestet (kein Key); Provider nur mit Fakes geprüft |
| MECE-Waves | Vollständig | .mece-control/server.mjs, services.sh, Browsercheck 27/27 | — |
| Browser Runtime | Vollständig (lokal) | browser-runtime-host/server.mjs, /api/browser/* | OS-Libs installiert |
| API Anything | Vollständig (Code) | src/mcp-client.ts, src/discovery.ts, tests/discovery-mcp-schedules.test.ts | Live-Smoke zu YouTube manuell |
| MCP | Teilweise | src/index.ts:1402,1408 | Runtime host verbunden; Discovery-MCP nicht konfiguriert |
| Creator Discovery | Teilweise | src/discovery.ts:27-125 | DISCOVERY_MCP_CLIENT unset |
| YouTube Discovery | Vollständig (Code) | src/discovery.ts, tests/discovery-cursor-retry.test.ts | Live-Quelle nicht konfiguriert; Cursor/Retry gegen Fake-MCP geprüft |
| Affiliate Management | Vollständig | src/affiliate.ts, /api/affiliate/*, tests/affiliate.test.ts | Manuelle Erfassung; kein externes Affiliate-Netzwerk |
| Kampagnenmanagement | Vollständig (CRUD) | src/index.ts:392-406 | — |
| Video Clipping | Vollständig (Code) | src/video/clipping.ts, src/video/subtitles.ts, tests/video-pipeline.test.ts, /api/media/export | ffmpeg/ffprobe lokal nicht installiert (NOT_CONFIGURED) |
| Transkription & Highlights | Vollständig (Code) | src/transcription.ts, tests/transcription.test.ts, /api/media/transcription/* | Whisper-Binary/Modell lokal nicht installiert |
| Publishing | Mock/Platzhalter | src/orchestration.ts:205 | Keine Plattform-Clients |
| Analytics | Teilweise | src/index.ts:320-358 | Keine externen Quellen |
| Multi-Account | Vollständig | lib/auth.ts, src/index.ts:139-149 | UI nur erster Workspace |
| Self-Healing | Vollständig (Code) | src/engine.ts, scripts/autonomous-controller.mjs | Nicht dynamisch geprüft |
| Self-Improving | Vollständig | src/self-improving.ts, tests/self-improving.test.ts, GET /api/self-improving | Vorschläge nur beratend, keine automatische Richtlinienänderung |
| Scheduler | Vollständig (Code) | src/engine.ts:468-521 | Laufzustand nicht geprüft |
| Security | Vollständig | tests/jobs-approval-regression.test.ts, tests/deterministic-agent-output.test.ts | — |
| Frontend | Teilweise | public/app.js, public/index.html | Stale Labels entfernt; MECE-Link geprüft |
| Deployment | Blockiert | docs/release/PRODUCTION-ROADMAP.md:41 | Keine Credentials |
| E2E-Tests | Vollständig | playwright.config.ts, tests/e2e/mece.spec.ts (8/8), Browsercheck 27/27 | — |
