# Phase I — Bestandsinventar (I.0)

Datum: 2026-11-28 · Branch `feature/phase-i-self-healing-self-improving` · Baseline `main` `5c41045`

## Herkunft / Sicherung

- 12 uncommittete Dokumentänderungen aus Phase H (Roadmap, STATE, NEXT_SESSION,
  BLOCKERS, Phase-I-Vorbereitung) unverändert übernommen.
- Sicherung ohne Commit: `/tmp/opencode/phase-i-recovery/docs.patch`,
  `/tmp/opencode/phase-i-recovery/docs.tgz`.
- Kein Commit/Push/Merge; Phase-H-Arbeitsstand bleibt in `main` erhalten.

## Vorhandene Funktionen (weiterverwenden, nicht duplizieren)

| Bereich | Datei | Funktionen |
|---|---|---|
| Self-Healing | `src/self-healing.ts` | `classifyErrorCode`, `classifyAuditEvent`, `collectHealingProposals`, `proposeHealing`, `applyHealing`, `rollbackHealingMutations`; sichere Aktionen `clear_stale_lease`, `promote_due_retry_wait` |
| Self-Improving | `src/self-improving.ts` | `deriveSuggestions`, `collectSelfImprovement` (Evidenz aus Audit-Events) |
| Engine-Recovery | `src/engine.ts` | `recoverStaleWorkflowRuns`, `runEngineTick`, Lease-Fencing |
| Job-Recovery | `src/jobs.ts` | `recoverExpiredJobs`, DLQ-Requeue, Backoff |
| Orchestration | `src/orchestration.ts` | Lease-Recovery, Approval-Gates, `runOrchestration` |
| Controller | `scripts/autonomous-controller.mjs`, `controller-core.mjs`, `controller-supervisor.sh` | Journal, Heartbeat, Cooldowns, Free-Model-Allowlist |
| Watchdog | `scripts/controller-watchdog.sh`, `controller-watchdog-scheduler.sh` | STOP/Cooldown-Erkennung, `SKIPPED_COOLDOWN` |
| QA-Runtime | `scripts/qa-full.mjs` | flock, isolierte PostgreSQL, Watchdog, Source-Freeze-Prüfung |
| Audit/Trace | `src/qa-trace.ts`, `lib/audit.ts` | strukturierte Traces, redactete Audit-Events |

## Lücken (Phase I neu)

- Keine persistente Incident-Entität mit Severity/Deduplizierung/Historie.
- Keine einheitliche Health-/Ressourcenüberwachung (Ports, Prozesse, CPU/RAM,
  `pg_stat_activity`, Leases, Freeze-Hash).
- Recovery-Workflow nicht explizit als Detect→…→Rollback modelliert; bestehende
  sichere Aktionen sind nicht mit den INC-PH-01..06-Fällen verdrahtet.
- keine persistenten Improvement-Tasks mit Vorher-/Nachher-Messung.
- keine Sandbox-/Coding-Agent-Integration mit Patch-Review und Freigabe.
- keine Phase-I-Panels im Control Center.

## Status

I.0 **completed**; nächste offene Aufgabe: I.1 Monitoring/Incident Management.
