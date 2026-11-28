# Phase I — Self-Improving Architektur (vorbereitet)

Status: **Entwurf, nicht implementiert**.

## Ziel

Kontrollierte Selbstverbesserung: aus **echten** Incident-/Audit-Daten werden
Verbesserungsvorschläge abgeleitet, in einer isolierten Sandbox umgesetzt,
automatisch getestet und einem Review-Agenten vorgelegt. Kein Direkt-Commit,
keine Selbstmodifikation der Governance, keine bezahlten Modelle.

## Pipeline

1. **Evidenz**: `AuditEvent`, Incidents aus I.1,QA-Reports, Watchdog-Daten.
2. **Vorschlag**: strukturiert mit `problem`, `evidenceIds`, `proposedChange`,
   `expectedEffect`, `risk`, `rollback`. Kein Vorschlag ohne Evidenz.
3. **Priorisierung**: Häufigkeit × Schwere × Vertrauen; Board nur mit echten Zahlen.
4. **Sandbox**: `git worktree` unter `/tmp/opencode`, nie im Hauptarbeitsbaum.
5. **Implementierung**: nur kostenlose Modelle/Dienste; keine Secrets.
6. **Tests**: Typecheck/ESLint/Build/Vitest im Worktree; keine bestehende
   Testabschwächung; bei Fehlschlag Vorschlag `rejected`.
7. **Review-Agent**: unabhängige Prüfung gegen Akzeptanzkriterien; Ergebnis
   `approved_for_human` — niemals automatisch gemergt.
8. **Mensch**: explizite Freigabe für Übernahme in den Hauptbranch.

## Ausschlüsse

- Keine Änderung an `STOP`, Controller-State, Governance-Dateien, `.env`,
  Freigabe- oder Security-Logik ohne Mensch.
- Keine eigenen Commits/Pushes/PRs/Merges.
- Kein Paid-Fallback; kein simuliertes Modell-Ergebnis.
- Kein "Erfolg" ohne bestandene Tests.

## Erste Vorschläge aus Phase H (Evidenz vorhanden)

- Port-Owner-Erkennung vor Dienststart (INC-PH-02).
- Freeze-Hash-Gate als Pflichtschritt vor QA (INC-PH-05).
- `pg_stat_activity`-Watchdog für eigene Transaktionen (INC-PH-03).
- QA-Preflight-Owner-Prüfung ohne Fremdprozess-Stopp (INC-PH-06).
