# NEXT SESSION

## Einstieg

- Repo: `/home/kaishinglo/ugc-affiliate-creator-clipping-os`
- Branch: `main`. Letzter geprüfter Checkpoint vor dieser Sitzung: `7171dcb`.
  Dieser final geprüfte Stand wird als neuer lokaler Checkpoint erstellt;
  keine Pushes, Merges oder Deployments. Vorhandene Benutzeränderungen bleiben
  uncommitted.
- Node 22, TypeScript strict, Fastify/Prisma 7/PostgreSQL, Vitest.
- Finale QA: Typecheck, `eslint .`, Build PASS; Vitest **225/225** (57 Dateien);
  MECE-Browsercheck **27/27**, UGC-Main-UI-Check **5/5**, Playwright **8/8**;
  `npm run verify:media` real grün (`SSIM All = 0.930179`).

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

## Nächste sinnvolle Aufgaben

1. Autonomen Controller erst nach Ablauf der `GLOBAL_FREE_QUOTA`-Cooldowns
   (`2026-11-25T04:59:00.966Z`) und einem erneuten begrenzten Free-Call
   starten. Aktuell bewusst gestoppt; kein Workaround, kein Paid-Fallback.
2. Discovery-MCP/YouTube nur mit konfigurierten Tier-1-Zugangsdaten live
   prüfen; der Pilot scheiterte mit `UND_ERR_HEADERS_OVERFLOW`. Kein Tier-2-
   oder Paid-Fallback.
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

- Live-KI im Phase-D-Sinn: `GLOBAL_FREE_QUOTA` bis
  `2026-11-25T04:59:00.966Z`; `opencode/beam-free` lieferte separat echt `OK.`.
- `DISCOVERY_MCP_SERVER` / `DISCOVERY_MCP_CLIENT`, YouTube-Zugang,
  Plattform-Credentials (Publishing), externe Analytics, Deployment-Credentials.
- MECE-Chat: OpenCode-Server :4096 wurde wegen belegtem Port nicht gestartet;
  der Startfehler wird jetzt sichtbar angezeigt, kein Fake-Erfolg.
- Ollama-Cloud-Live-Call ohne `OLLAMA_API_KEY` nicht prüfbar; die
  OpenCode-Free-Modelle sind davon unabhängig.
