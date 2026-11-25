# NEXT SESSION

## Einstieg

- Repo: `/home/kaishinglo/ugc-affiliate-creator-clipping-os`
- Branch: `main`, letzter lokaler Checkpoint ist dieser Phase-D-Media-Commit
  (nach `0b5c806`); keine Pushes, Merges oder Deployments. Vorhandene
  Benutzeränderungen wurden bewahrt.
- Node 22, TypeScript strict, Fastify/Prisma 7/PostgreSQL, Vitest.
- QA-Baseline vor Phase C: Typecheck/ESLint/Build PASS, Vitest 143/143,
  Browsercheck 27/27. Phase-C-Ziel: alle neuen Tests grün, Baseline unverändert.

## Startbefehle

Alle lokalen Dienste (UGC :3000, MECE :3031, Browser-Runtime :3200):

```bash
cd /home/kaishinglo/ugc-affiliate-creator-clipping-os
bash scripts/services.sh start      # oder: stop | restart | status
bash scripts/services.sh status
```

 MECE-Control-Token liegt ausschließlich in `.env` (gitignored, Modus 600) und
 wird im Browser nur in `sessionStorage` gehalten. Kein Token in HTML, Logs oder
 Commits.

Optionaler autonomer Controller (bewusst nicht dauerhaft gestartet):

```bash
node scripts/autonomous-controller.mjs --status
node scripts/autonomous-controller.mjs --once       # ein Task, dann Stopp
node scripts/autonomous-controller.mjs --stop       # STOP-Flag setzen
bash scripts/controller-supervisor.sh               # Watchdog, nur explizit
```

## Erledigt (2026-11-24)

- MECE Control Center aktiviert: sicherer Token-Login, Origin-Gate, Fail-Closed
  401, SHA-256/Timing-Safe-Vergleich, keine MCP-Secret-Werte in Responses.
- UGC-Dashboard verlinkt MECE; Fastify-Bridge `/api/control/status` liefert
  echten MECE-/UGC-/Controller-Status (unauth 401, auth 200).
- Redundanter Statikserver `scripts/serve.mjs` (:4173) entfernt.
- Einheitliche Services über `scripts/services.sh` und `package.json`.
- Vier historische Testfehler behoben; vollständige Suite grün.
- Node-Controller mit flock, Heartbeat, Journal-Replay, Cooldowns,
  Ressourcen-Gates, Verifikationsstufen und sicheren lokalen Checkpoints.
- Controller-Discovery auf echte Matrix-Lücken + diese Datei begrenzt;
  historische `Next:`-Tasks aus `docs/autonomous-build/*.md` wurden im
  Journal als `obsolete` markiert (keine Code-Fehler).

## Phase C erledigt (2026-11-25)

- CEO/COO persistente Entscheidungen + CEO-Synthesis-Validierung
  (`src/company-agents.ts`, `tests/company-agents.test.ts`).
- YouTube-Discovery mit Cursor in `OperationalPolicy` und begrenztem
  Exponential-Backoff (`src/discovery.ts`, `tests/discovery-cursor-retry.test.ts`).
- FFmpeg/FFprobe-Pipeline, Untertitel, Hochformat, Transkription und
  Highlight-Erkennung mit explizitem `NOT_CONFIGURED`
  (`src/video/*`, `src/transcription.ts`, `tests/video-pipeline.test.ts`,
  `tests/transcription.test.ts`) plus workspace-scoped Media-API.
- Self-Improving als deterministischer Audit-Event-Rules-Learner ohne
  automatische Richtlinienänderung (`src/self-improving.ts`).
- Repo-Playwright-Suite `playwright.config.ts` + `tests/e2e/mece.spec.ts`: 8/8.

## Phase D erledigt (2026-11-25)

- FFmpeg/FFprobe 7.1.5 installiert; whisper.cpp 1.9.6-dev mit
  `ggml-tiny.en.bin` lokal gebaut und mit echtem JFK-Sprachsample betrieben.
- `extractAudio()`, `POST /api/media/extract-audio`, echte SRT-Zeitstempel und
  thread-begrenzte Whisper-Läufe ergänzt. Highlight-Zeiten stammen jetzt aus
  der echten SRT, nicht aus dem untimed Text.
- Reproduzierbarer Real-Lauf: `npm run verify:media`. Report und Frame liegen
  unter `/tmp/opencode/ugc-media-verify/`; SSIM 0.930179 gegen Clipart ohne
  Untertitel. Vitest 175/175, Typecheck/ESLint/Build PASS.

## Nächste sinnvolle Aufgaben

1. Publishing-Adapter (YouTube/TikTok/Instagram) mit `NOT_CONFIGURED`,
   Warteschlange, Retry, Idempotenz, Audit und manueller Freigabe fertigstellen.
2. Analytics/Affiliate echte lokale Datenquellen zusammenführen und fehlende
   Daten explizit markieren.
3. `scripts/services.sh doctor` und externen Controller-Watchdog ergänzen;
   Cooldown bis `2026-11-25T04:59:00.966Z` strikt respektieren.
4. Discovery-MCP/YouTube, Plattform-Credentials und externe Analytics-Quellen
   bleiben extern blockiert und werden nicht simuliert.
5. Legacy-Archive `docs/completion/TASK_QUEUE.txt`, `COMPLETED_TASKS.txt` und
   `FAILED_TASKS.txt` als reines Archiv kennzeichnen; nichts löschen.
6. Autonomen Controller mit persistentem Fortschritt wieder starten, sobald die
   `GLOBAL_FREE_QUOTA`-Cooldowns abgelaufen sind (bis
   `2026-11-25T04:59:00.966Z`) und ein erneuter begrenzter Free-Model-Call
   erfolgreich war. Aktuell: bewusst gestoppt.
7. Vollständigen UGC-Workflow und alle Frontend-Tabs mit echtem Chromium
   abschließen; keine Platzhalter als Erfolg ausgeben.

## Extern blockiert (nicht mit freien Ressourcen lösbar)

- `OLLAMA_API_KEY` fehlt; echter Live-Call nicht verifiziert. Historisch:
  `Free usage limit reached` / `Connect a provider or subscribe`. Der Controller
  pausiert dafür korrekt mit `quota_wait` und greift auf **kein** kostenpflichtiges
  Fallback-Modell zurück.
- `DISCOVERY_MCP_SERVER` / `DISCOVERY_MCP_CLIENT`, YouTube-Zugang,
  Plattform-Credentials (Publishing), externe Analytics, Deployment-Credentials.
- RLS-Blocker gelöst: `DATABASE_URL` nutzt `ugc_os_app` (`rolsuper=f`,
  `rolbypassrls=f`), `tests/workspace-isolation.test.ts` 5/5 PASS.
