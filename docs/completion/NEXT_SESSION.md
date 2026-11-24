# NEXT SESSION

## Einstieg

- Repo: `/home/kaishinglo/ugc-affiliate-creator-clipping-os`
- Branch: `main`, letzter lokaler Checkpoint `f77dd81` (Phase A/B) plus Phase-C
  Änderungen; keine Pushes, Merges oder Deployments. Vorhandene
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

## Nächste sinnvolle Aufgaben

1. Externe Blockaden auflösen (ffmpeg/whisper, Discovery-MCP/YouTube,
   Plattform-Credentials, Analytics-Quellen, Deployment) und die bestehenden
   `NOT_CONFIGURED`-Verträge mit echten Läufen verifizieren.
2. `scripts/services.sh` um einen `doctor`-Modus erweitern (Ports, Auth,
   Controller-Heartbeat, Medien-Binaries).
3. Legacy-Archive `docs/completion/TASK_QUEUE.txt`, `COMPLETED_TASKS.txt` und
   `FAILED_TASKS.txt` als reines Archiv kennzeichnen; nichts löschen.
4. Autonomen Controller mit persistentem Fortschritt erst nach vollständiger
   grüner QA und ohne extern limitierte Modelle wieder starten.

## Extern blockiert (nicht mit freien Ressourcen lösbar)

- `OLLAMA_API_KEY` fehlt; echter Live-Call nicht verifiziert. Historisch:
  `Free usage limit reached` / `Connect a provider or subscribe`. Der Controller
  pausiert dafür korrekt mit `quota_wait` und greift auf **kein** kostenpflichtiges
  Fallback-Modell zurück.
- `DISCOVERY_MCP_SERVER` / `DISCOVERY_MCP_CLIENT`, YouTube-Zugang,
  Plattform-Credentials (Publishing), externe Analytics, Deployment-Credentials.
- RLS-Blocker gelöst: `DATABASE_URL` nutzt `ugc_os_app` (`rolsuper=f`,
  `rolbypassrls=f`), `tests/workspace-isolation.test.ts` 5/5 PASS.
