# Test-Isolation / QA-Runtime (Phase E.1)

## Dauerhafter Full-Suite-Lauf

```bash
npm run qa:full
```

Der Befehl nutzt `flock -n /tmp/opencode/ugc-qa-full.lock`, damit nie zwei
Läufe gleichzeitig dieselbe Suite fahren. `scripts/qa-full.mjs`:

- startet eine **eigene temporäre PostgreSQL-Instanz** mit freiem Port und
  Rolle `ugc_os_app` (`NOSUPERUSER`, `NOBYPASSRLS`), Datenbank `ugc_os_qa`;
- wendet alle Migrationen an (48 Tabellen) und stoppt die Instanz am Ende
  zuverlässig;
- räumt bei Crash-Recovery verwaiste QA-Cluster vorheriger Läufe auf;
- prüft vorher, dass `BROWSER_RUNTIME_URL` erreichbar ist, und startet den
  Browser-Dienst nur, wenn QA ihn selbst gestartet hat;
- verweigert den Start, wenn UGC :3000 oder Control :3031 laufen — fremde
  Prozesse werden nicht beendet;
- führt Vitest mit `--maxWorkers=1` aus;
- überwacht mit einem Watchdog (Standard 15 min Timeout, 3 min ohne Ausgabe)
  und samplt CPU/RSS/Load;
- schreibt persistente Fortschrittsdateien
  (`/tmp/opencode/qa-full/latest-progress.json`, `<run>/progress.json`) sowie
  `report.json` / `report.md`, Trace, Vitest- und Postgres-Logs.
- `QA_TRACE_FILE` aktiviert die Instrumentierung; ohne die Variable ist sie
  inaktiv. Keine Secret-Werte in irgendeiner Ausgabedatei.

Konfiguration: `QA_FULL_TIMEOUT_MS`, `QA_FULL_STALL_MS`, `QA_FULL_SAMPLE_MS`,
`QA_FULL_OUT_DIR`.

## Warum die Isolation nötig ist

Ein Dev-Server mit `AUTOMATION_ENGINE=on` pollt dieselbe DB und konkurriert
um Jobs/Leases. Ein fehlender Browser-Dienst ändert korrekt
`/api/browser/status` auf `available=false`, während ein Test bei gesetztem
`BROWSER_RUNTIME_URL` Verfügbarkeit erwartet. Beides sind Umgebungsfehler,
keine Codefehler — nachgewiesen in `docs/testing/ROOT_CAUSE_ANALYSIS.md`.

## Regeln

- Tests nutzen workspace-eigene IDs; keine Produktionsdaten löschen.
- Immer zuerst den betroffenen Test, dann die betroffenen Dateien gemeinsam,
  erst danach die vollständige Suite.
- Keine pauschalen Timeout-Erhöhungen, keine abgeschwächten Assertions,
  keine Fake-Erfolge, keine erfundenen Kennzahlen.
- UGC :3000 und Control :3031 bleiben für `qa:full` gestoppt; Browser :3200
  muss erreichbar sein. Nach Playwright-Läufen werden die selbst gestarteten
  Dienste wieder gestoppt.
