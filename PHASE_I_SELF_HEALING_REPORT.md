# Phase I — Self-Healing Report (2026-11-28)

## Implementierter Workflow

`Detect → Diagnose → Plan → Policy Check → Approval → Execute → Verify → Audit → Rollback`

- **Detect**: `inspectPorts`, `inspectProcesses`, `inspectDatabase` (pg_stat_activity),
  `inspectFreeze`; Persistenz in `Incident` mit Fingerprint-Deduplizierung.
- **Diagnose**: `diagnoseIncident` speichert Klassifikation; `diagnoseIncidentKind`
  ist deterministisch für die sechs Realfälle.
- **Plan/Policy**: `planRecovery` erzeugt `RecoveryRun`; Fremdfälle werden
  ausschließlich als `report_only` klassifiziert.
- **Approval**: `approveRecovery` erzeugt eine `Approval(entityType=recovery_run)`
  mit decidBy/decidedAt; Ausführung verlangt gültige, nicht widerrufene Freigabe.
- **Execute**: nur zwei sichere Mutationen — `clear_stale_lease` (abgelaufene
  eigene Leases) und `promote_due_retry_wait` (fällige eigene RETRY_WAIT-Jobs).
- **Verify**: Erfolgskriterium ist die tatsächliche Mutation bzw. `report_only`;
  sonst `failed`.
- **Audit**: `recovery_planned`, `recovery_approved`, `recovery_executed`,
  `recovery_failed`, `recovery_rolled_back`.
- **Rollback**: Snapshot der betroffenen Job-Zeilen wird gespeichert und kann
  deterministisch wiederhergestellt werden.

## Realfälle

| Fall | Klasse | Aktion |
|---|---|---|
| INC-PH-01 konkurrierende Prozesse | foreign_process | report_only |
| INC-PH-02 Portkonflikt | port_owner_unknown | report_only |
| INC-PH-03 idle in transaction | database_transaction | report_only |
| INC-PH-04 QA-Watchdog | qa_runtime | report_only |
| INC-PH-05 Source-Drift | freeze_drift | report_only |
| INC-PH-06 QA-Preflight | service_state | report_only |

Zusätzlich: `stale_job_lease` → `clear_stale_lease`, `due_retry_wait` →
`promote_due_retry_wait`.

## Schutz

Kein automatisches Beenden fremder Prozesse oder Transaktionen. Kein
`git checkout/reset/clean` im Hauptarbeitsbaum. Kill-Switch und Budget werden
unmittelbar vor der Ausführung geprüft.

## Tests

`tests/phase-i.test.ts` deckt Deduplizierung, RLS-Isolation, Approval-Bypass,
Ausführung, Audit-Trail, Rollback und die sechs Klassen ab.
