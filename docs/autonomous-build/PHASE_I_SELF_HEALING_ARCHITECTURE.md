# Phase I — Self-Healing Architektur (vorbereitet)

Status: **Entwurf, nicht implementiert**.

## Ziel

Automatische Selbstheilung anhand **tatsächlich aufgetretener** Fehler aus
Phase G/H — nicht theoretischer Szenarien. Grundsatz: **erkennen, klassifizieren,
vorschlagen, freigeben, ausführen, verifizieren, auditieren**.

## Pipeline

1. **Signale** (read-only): Prozess-Registry (PID, PPID, Owner, Worktree),
   Port-Scan (`ss -ltnp`), `pg_stat_activity`, QA-Watchdog/Progress,
   Freeze-Hash-Manifest, Health-Endpunkte.
2. **Incident** (persistent, workspace-/run-scoped): `id`, `kind`, `detectedAt`,
   `evidence`, `classification`, `proposedAction`, `approvalRequired`.
3. **Klassifikation**: `own` vs. `foreign`; `transient` vs. `persistent`;
   `safe_to_remediate` vs. `approval_required`.
4. ** remediation plan**: deterministisch, mit Rollback-Schritt und(expected)
   Verifikation. Kein Plan ohne Evidenz.
5. **Freigabe**: bei `foreign` oder destruktiver Aktion immer Mensch.
6. **Ausführung**: geliehener Lease, Timeout, Audit-Event vor/nach Aktion.
7. **Verifikation**: Signal erneut prüfen; bei Misserfolg Incident `unresolved`.
8. **Rollback**: gespiegelter Zustand (Prozess-Liste, DB-Session-ID, Port-Owner).

## Konkrete Startfälle

| Fall | Signal | Erlaubte Automatik |
|---|---|---|
| INC-PH-01 konkurrierende Prozesse | Freeze-Hash-Drift, unbekannte PIDs | nur eigene Kinder stoppen, nie fremde |
| INC-PH-02 Portkonflikt | `EADDRINUSE`, `ss -ltnp` | nur eigene Dienste neu starten, fremden PID Report |
| INC-PH-03 idle transaction | `pg_stat_activity.state='idle in transaction'`, Dauer | nur eigene Session canceln, nie fremde |
| INC-PH-04 QA-Watchdog | `latest-progress.json`, Exit 143 | stale Cluster eigener Runs aufräumen |
| INC-PH-05 Source-Drift | Hash-Manifest mismatch | QA-Urteil verwerfen, Incident |
| INC-PH-06 Preflight blockiert | UGC/Control erreichbar während QA | QA abbrechen, Dienste nicht fremd stoppen |

## Schutzgrenzen

- Kein `kill -9` auf fremde Prozesse; kein `kill` ohne Owner-Nachweis.
- Kein `pg_terminate_backend` auf fremde Sessions.
- Kein automatisches `git checkout`, `reset`, `clean` in fremden Arbeitsbaum.
- STOP-Flag und Controller-Status bleiben unangetastet.
- Jede Aktion erzeugt Audit-Event mit Evidenz, Plan, Ergebnis und Rollback-Status.
