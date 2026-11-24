# NEXT SESSION

## Einstieg

- Repo: `/home/kaishinglo/ugc-affiliate-creator-clipping-os`
- Branch: `main`, HEAD `ef0e4347bd344389866f10ba7623eff33d1a56de`
- Arbeitsbaum: alle Änderungen dieser Sitzung sind **uncommitted**; keine Pushes,
  Merges oder Deployments. Vorhandene Benutzeränderungen wurden bewahrt.
- Node 22.23.5, npm 10.9.9, Debian 13, 2 CPUs, 4 GB RAM
- Gesamt-QA (2026-11-24): Typecheck PASS, ESLint PASS, Build PASS,
  Vitest 41 Dateien / 143 Tests PASS, MECE-Browsercheck 27/27 PASS.

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

## Nächste sinnvolle Aufgaben

1. Repo-basierte Playwright-Suite `tests/mece-browser.test.ts` ergänzen, die den bestehenden Smoke-Flow (Login, 401, Tabs, Modellwahl) gegen :3031 ausführt.
2. `scripts/services.sh` um einen `doctor`-Modus erweitern, der Ports, Auth-Fail-Closed und Controller-Heartbeat prüft.
3. Legacy-Archive `docs/completion/TASK_QUEUE.txt`, `COMPLETED_TASKS.txt` und `FAILED_TASKS.txt` nach der Journal-Migration als reines Archiv kennzeichnen; nichts löschen.
4. `Self-Improving` aus der Feature-Matrix mit einem lokalen, kostenlosen Rules-Learner umsetzen und mit Unit-Tests absichern.

## Extern blockiert (nicht mit freien Ressourcen lösbar)

- `OLLAMA_API_KEY` fehlt; echter Live-Call nicht verifiziert. Historisch:
  `Free usage limit reached` / `Connect a provider or subscribe`. Der Controller
  pausiert dafür korrekt mit `quota_wait` und greift auf **kein** kostenpflichtiges
  Fallback-Modell zurück.
- `DISCOVERY_MCP_SERVER` / `DISCOVERY_MCP_CLIENT`, YouTube-Zugang,
  Plattform-Credentials (Publishing), externe Analytics, Deployment-Credentials.
- `tests/workspace-isolation.test.ts` benötigt einen lokalen Non-Superuser;
  der `u0_a304`-Superuser umgeht FORCE RLS.
