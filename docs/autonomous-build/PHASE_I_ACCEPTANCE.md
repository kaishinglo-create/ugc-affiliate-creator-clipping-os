# Phase I — Test- und Abnahmekriterien (vorbereitet)

Status: **Entwurf, nicht implementiert**.

## Verbindliche Quality Gates

- Typecheck PASS · ESLint PASS (0 Fehler/Warnungen) · Build PASS.
- Alle 354 Baseline-Tests aus Phase H erhalten.
- Neue Tests für I.0–I.8 vollständig grün.
- Zwei isolierte `qa:full`-Läufe auf identischem, hash-verifiziertem Freeze.
- Playwright, MECE-Browsercheck, Frontendabnahme weiterhin grün.
- Migrationstest und Secret-Scan (inkl. untracked Dateien) 0 Treffer.

## Reproduzierte Realfälle (Pflicht)

Für jeden Fall INC-PH-01 bis INC-PH-06 aus `PHASE_I_TASKS.json`:

1. Fall kontrolliert reproduzieren (Test-Double oder isolierter Prozess).
2. Erkennung muss den Incident mit Evidenz erzeugen.
3. Klassifikation `own`/`foreign` muss stimmen.
4. Fremde Prozesse dürfen **nicht** automatisch beendet werden.
5. Audit-Event muss Plan, Ergebnis und Rollback-Status enthalten.
6. Verifikation muss den gelösten Zustand bestätigen oder `unresolved` melden.

## Self-Improving-spezifisch

- Vorschläge nur mit Evidenz aus echten Audit-/Incident-Daten.
- Sandbox-Worktree getrennt vom Hauptarbeitsbaum.
- Alle Tests im Worktree grün; Review-Agent `approved_for_human`.
- Kein Commit, Push, PR oder Merge ohne separate Freigabe.
- Keine Änderung an gesperrten Governance-Dateien.

## Governance-Checks

- STOP-Datei unverändert vorhanden.
- Controller/Supervisor `stopped`.
- Budgetreservierung atomar; bei Erschöpfung `deferred`.
- Keine echten Veröffentlichungen, kein Deployment, keine bezahlten Dienste.

## Finalstatus

`PHASE_I_COMPLETE` nur bei vollständig bestandenen Gates; sonst
`PHASE_I_PARTIAL` mit konkreten offenen Aufgaben.
Phase J wird erst nach separater Freigabe vorbereitet.
