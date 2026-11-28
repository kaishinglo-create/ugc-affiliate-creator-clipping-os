# Phase I — Feature Matrix

Stand: Implementierung abgeschlossen, Finalabnahme läuft.

| ID | Fähigkeit | Status | Nachweis |
|---|---|---|---|
| I.1.01 | Health Checks (Ports/Prozesse/DB/Freeze) | V | `src/incident-monitor.ts`, `/api/system/health` |
| I.1.02 | Incident-Deduplizierung + Severity + Historie | V | `Incident.fingerprint`, partial unique index, `recordIncident` |
| I.1.03 | Root-Cause-/Evidenzdiagnose | V | `diagnoseIncident`, `diagnoseIncidentKind` |
| I.2.01 | Detect→Diagnose→Plan→Policy→Approval→Execute→Verify→Audit→Rollback | V | `src/recovery-engine.ts` |
| I.2.02 | INC-PH-01..06 als Realfälle | V | `diagnoseIncidentKind`, Tests |
| I.2.03 | Keine fremden Prozesse/Transaktionen stoppen | V | Policy `report_only` für alle Fremdfälle |
| I.2.04 | Lease-/Retry-Recovery, Budget, Timeout, Rollback | V | `clear_stale_lease`, `promote_due_retry_wait`, Tages-Cap, Snapshot |
| I.3.01 | Persistente Improvement-Tasks | V | `src/improvement-engine.ts`, `ImprovementTask` |
| I.3.02 | Priorisierung + Vorher-/Nachher-Messung | V | `priorityScore`, `beforeJson/afterJson` |
| I.4.01 | Worktree-Sandbox + Fail-closed Opt-in | V | `src/coding-agent.ts`, `PHASE_I_SANDBOX_ENABLED` |
| I.4.02 | Deterministischer Patch, Tests, Review, Freigabe | V | `proposePatch`, `runSandboxTests`, `reviewSandbox` |
| I.4.03 | Keine echten Commits/Pushes/Merges | V | keine entsprechenden Aufrufe im Modul |
| I.5.01 | CEO/COO/Departments nutzen echte Phase-I-Daten | V | `src/phase-i-agent-context.ts`, Orchestration-Merge |
| I.6.01 | System Health / Incident / Recovery / Improvement / Sandbox Panels | V | `public/app.js`, `/api/system/*`, `/api/recoveries`, `/api/improvements`, `/api/sandboxes` |
| I.7.01 | Typecheck/ESLint/Build | V | Exit 0 |
| I.7.02 | Tests 362/362 in 88 Dateien | V | vollständige Suite |
| I.7.03 | Zwei isolierte qa:full | pending | Läufe auf Freeze `33203e43…` |
| I.7.04 | Browser-Gates, Medien, Migration, Security | pending | offen |

Legende: V = implementiert · pending = Abnahme läuft.

Externe Blocker betreffen ausschließlich echte Provider-/Live-Verifikation;
alle hier aufgeführten Funktionen sind lokal implementiert.
