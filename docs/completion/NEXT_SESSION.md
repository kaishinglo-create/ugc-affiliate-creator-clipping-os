# NEXT SESSION

## Einstieg

- Repo: `/home/kaishinglo/ugc-affiliate-creator-clipping-os`
- Branch: `main`. Ausgangspunkt `d97f8ca` (Phase D); Phase E/E.1 wird in
  diesem Schritt als **lokaler Checkpoint** gesichert (siehe `git log -1`).
  Kein Push, Merge oder Deploy. Vorhandene Benutzeränderungen und
  Laufzeit-Artefakte (Logs, `3`, Controller-Status) bleiben bewusst
  uncommitted.
- Node 22, TypeScript strict, Fastify/Prisma 7/PostgreSQL, Vitest.
- Finale QA Phase D: Typecheck, `eslint .`, Build PASS; Vitest **225/225**
  (57 Dateien); MECE-Browsercheck **27/27**, UGC-Main-UI-Check **5/5**,
  Playwright **8/8**; `npm run verify:media` real grün (`SSIM All = 0.930179`).
- Finale QA Phase E: Typecheck/ESLint/Build PASS; Playwright **8/8** mit
  Screenshots; `npm run verify:media` echt grün für **EN und DE**
  (`SSIM All = 0.883772`); Secret-Scan `checkedValues=4`, `matches=0`.

## Startbefehle

Alle lokalen Dienste (UGC :3000, MECE :3031, Browser-Runtime :3200):

```bash
cd /home/kaishinglo/ugc-affiliate-creator-clipping-os
bash scripts/services.sh start      # oder: stop | restart | status
bash scripts/services.sh status
bash scripts/services.sh doctor
```

MECE-Control-Token liegt ausschließlich in `.env` (gitignored, Modus 600) und
wird im Browser nur in `sessionStorage` gehalten. Kein Token in HTML, Logs,
Commits oder JSON-Ausgaben. `SESSION_JWT_SECRET` ist jetzt in **jeder**
Umgebung erforderlich; es gibt keinen statischen Dev-Fallback mehr.
`TRUST_PROXY` ist fail-closed; `true`/`1` nur bei bewusst vertrautem Proxy.

Optionaler autonomer Controller (bewusst nicht dauerhaft gestartet):

```bash
node scripts/autonomous-controller.mjs --status
node scripts/autonomous-controller.mjs --once       # ein Task, dann Stopp
node scripts/autonomous-controller.mjs --stop       # STOP-Flag setzen
bash scripts/controller-watchdog.sh                 # respektiert Cooldowns
```

## Phase D erledigt (2026-11-25)

- Echter FFmpeg-/Whisper-Lauf mit 720x1280 H.264/AAC, SRT-Burn-in und
  `SSIM All = 0.930179`; Report unter `/tmp/opencode/ugc-media-verify/`.
- RLS mit Nicht-Superuser `ugc_os_app` verifiziert (`rolsuper=f`,
  `rolbypassrls=f`), `tests/workspace-isolation.test.ts` 5/5 PASS.
- Doctor und Watchdog real geprüft: `SKIPPED_COOLDOWN`, `started: false`,
  `success: false`, `paidFallbackAttempted: false`.
- Publishing mit Approval-Gate, Queue, Retry, Idempotenz, Audit und ehrlichem
  Adapterstatus; generische Job-Routen blockieren Publishing-Jobs mit 409
  `USE_PUBLISHING_PROCESS_ENDPOINT`. `tests/publishing.test.ts` 7/7.
- Analytics mit echten Workspace-Prisma-Quellen, expliziten `missing`-Markern
  und getrennten Affiliate-/Cash-Werten inklusive `GET /api/analytics/sources`.
  `tests/analytics-sources.test.ts` 5/5.
- Self-Healing mit 14/14 Logiktests und read-only
  `GET /api/self-healing/proposals`; nichts wird als `applied` markiert.
- Frontend/MECE mit echten Fehlern, echtem Logout, sichtbarem Chat-Startup und
  authentifizierungsgated UI; Browserchecks 27/27, 5/5 und Playwright 8/8.
- Security-Findings F-01 bis F-10 lokal geschlossen, inklusive Symlink-Härtung,
  Wegfall des Dev-JWT-Fallbacks, zentraler Redaction, deterministischem
  `TRUST_PROXY` und DNS-/IP-Prüfung für Browser-URLs. Secret-Scan: 0 Treffer.

## Phase E erledigt (2026-11-26)

- Publishing-Adapters mit explizitem Opt-in `PUBLISHING_LIVE_ADAPTERS=1|true`;
  ohne echte Credentials weiterhin ehrlich `NOT_CONFIGURED` (503) bzw.
  `CREDENTIALS_ONLY` + `ADAPTER_NOT_IMPLEMENTED` (501). Keine erfundenen Uploads.
- Discovery-Header-Overflow behoben (`maxHeaderSize: 32768`);
  `DISCOVERY_MCP_SERVER` bleibt bewusst leer, damit Tests keine echten Calls
  auslösen. Live-Smoke nach dem Fix steht noch aus.
- Frontend-Repair: 401-Flow, Discovery-Badge, Profil-/Control-URLs,
  Formular-Deduplizierung und echte Controls-/Media-Verträge
  (`tests/frontend-controls.test.ts`).
- MECE-Runtime mit konfigurierbaren Ports `/api/session`, Basic Auth, sicherer
  Reuse-Probe und redacteten Startfehlern; bei laufenden Diensten
  `MECE_TEST_CONTROL_PORT=3132 MECE_TEST_OPENCODE_PORT=4098` verwenden.
- Watchdog-Scheduler stoppt nach der ersten gebundenen Ausführung (`RAN_ONCE`);
  `tests/controller-watchdog-schedule.test.ts` 3/3. Controller bleibt gestoppt.
- Whisper-CLI statisch gegen ggml/whisper gelinkt, permanent unter
  `$HOME/.local/share/ugc-media/whisper` installiert; Hashes und Lizenzen in
  `docs/media/WHISPER_ASSETS.md`.
- ENV-Audit: `docs/configuration/ENV_REFERENCE.md` (97 Variablen mit Datei/Zeile,
  Default, Pflicht, Kostenlos, Status, Auswirkung) und
  `docs/configuration/ENV_STATUS.json` (`SET 30 · MISSING 65 · EMPTY 2`, keine
  Secret-Werte). Externe Portale/Berechtigungen sind separat aufgeführt.
- `.env` mit 9 lokalen Pfad-Keys repariert, Modus `600`, Backup
  `.env.backup-2026-11-26T15-27-10-041Z`; `.env.example` um 74 Keys ergänzt;
  `.gitignore` sichert `.env`, `.env.*`, `!.env.example`.

## Phase E.1 erledigt (2026-11-26)

- Ursache der Full-Suite-Instabilität nachgewiesen: keine
  Orchestrierungs-Codefehler, sondern konkurrierende Engine-Poller auf
  gemeinsamer DB, schwankende Browser-Dienstverfügbarkeit und akkumulierter
  DB-Zustand. Details und widerlegte Hypothesen:
  `docs/testing/ROOT_CAUSE_ANALYSIS.md`.
- Env-gesteuerte Trace-Infrastruktur `QA_TRACE_FILE` (`src/qa-trace.ts`) in
  DB-, Engine-, Orchestrierungs-, Lease-, Job- und Approval-Pfaden. Ohne die
  Variable inaktiv; keine Secrets/Tokens in Logs. Produktionslogik und
  bestehende Tests unverändert.
- Dauerhafte QA-Runtime: `npm run qa:full` (`scripts/qa-full.mjs`) mit `flock`,
  `--maxWorkers=1`, temporärer PostgreSQL-Instanz (`ugc_os_qa`, Rolle
  `ugc_os_app` ohne Superuser/BYPASSRLS), Watchdog, Fortschritt und Report.
  Für den Lauf müssen UGC :3000 und Control :3031 gestoppt sein; Browser :3200
  muss erreichbar sein. Siehe `docs/testing/TEST_ISOLATION.md`.
- Zwei vollständige Läufe grün: **262/262** Tests, **64/64** Dateien,
  `exitCode=0`, Watchdog nicht ausgelöst, DB sauber gestoppt. Reports:
  `/tmp/opencode/qa-full/qa-full-2026-11-26T17-33-21-901Z-29844/report.json`
  und `/tmp/opencode/qa-full/qa-full-2026-11-26T17-42-29-170Z-31926/report.json`.
- Final nach allen Änderungen: Typecheck, `eslint .` und Build PASS,
  Playwright **8/8** mit `node --env-file=.env`. Logs unter
  `/tmp/opencode/phase-e1-final-static.log` und
  `/tmp/opencode/phase-e1-final-playwright.log`.
- Phase F bleibt bis ausdrücklicher Freigabe pausiert.

## Nächste sinnvolle Aufgaben

1. Autonomen Controller erst nach ausdrücklicher Freigabe und einem erneuten
   begrenzten Free-Call starten. Doctor meldet `stopped`,
   `pauseReason=GLOBAL_FREE_QUOTA`, `cooldownActive=false`,
   `resumeAt=1795582740966`. Aktuell bewusst gestoppt; kein Workaround, kein
   Paid-Fallback.
2. Discovery-MCP/YouTube nach dem `maxHeaderSize`-Fix erneut als Tier-1-Smoke
   prüfen, sobald `DISCOVERY_MCP_SERVER` bewusst gesetzt werden darf. Kein
   Tier-2- oder Paid-Fallback.
3. Publishing erst mit echten Plattform-Credentials und manueller Freigabe
   live testen; ohne Credentials bleiben `NOT_CONFIGURED` /
   `CREDENTIALS_ONLY` + `ADAPTER_NOT_IMPLEMENTED` korrekt.
4. Externe Analytics-Quellen ergänzen, sofern verfügbar; fehlende Daten
   weiterhin explizit markieren, keine erfundenen Kennzahlen.
5. Legacy-Archive `docs/completion/TASK_QUEUE.txt`, `COMPLETED_TASKS.txt` und
   `FAILED_TASKS.txt` als reines Archiv kennzeichnen; nichts löschen.
6. Deployment erst mit echten Credentials und expliziter Freigabe; weiterhin
   kein Push/Merge/Deploy durch diesen Agenten.

## Extern blockiert (nicht mit freien Ressourcen lösbar)

- Live-KI im Phase-D-Sinn: Controller weiterhin `stopped` /
  `GLOBAL_FREE_QUOTA` ohne Freigabe; `opencode/beam-free` lieferte separat echt
  `OK.`; kein `OLLAMA_API_KEY`.
- `DISCOVERY_MCP_SERVER` / `DISCOVERY_MCP_CLIENT`, YouTube-Zugang,
  Plattform-Credentials (Publishing), externe Analytics, Deployment-Credentials.
- MECE-Chat: Fremder Port 4096 wird nicht bereinigt; MECE nutzt lokal
  `MECE_CONTROL_PORT=3031` und `MECE_OPENCODE_PORT=4097`. Startfehler werden
  sichtbar und redactet angezeigt, kein Fake-Erfolg.
- Ollama-Cloud-Live-Call ohne `OLLAMA_API_KEY` nicht prüfbar; die
  OpenCode-Free-Modelle sind davon unabhängig.
