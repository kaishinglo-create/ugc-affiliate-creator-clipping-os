# Phase I — Security & Governance Konzept (vorbereitet)

Status: **Entwurf, nicht implementiert**.

## Freigabegrenzen

| Aktion | Automatik | Freigabe |
|---|---|---|
| Incidents lesen/classifizieren | ja | – |
| eigene Kinder stoppen | ja, auditiert | – |
| fremde Prozesse stoppen | nie | Mensch, explizit |
| eigene DB-Session canceln | ja, auditiert | – |
| fremde DB-Session beenden | nie | Mensch, explizit |
| Worktree anlegen | ja | – |
| Code im Worktree ändern | ja | – |
| Hauptarbeitsbaum ändern | nie | Mensch |
| Commit/Push/PR/Merge | nie | Mensch, separat |
| Controller starten | nie | STOP-Flag bleibt |
| Deployment/Publishing | nie | Mensch, separat |

## Audit

Jede Autonomie-Aktion schreibt `AuditEvent` mit: `incidentId`, `actor`, `plan`,
`evidence`, `decision`, `outcome`, `rollbackStatus`, `timestamp`.
Audit-Events sind unveränderlich und workspace-/run-scoped.

## Budgetkontrolle

- Harte Tagesbudgets pro Workspace für Healing-/Improving-Aktionen.
- Atomic reservation via Advisory Lock (Muster aus `src/ai/gateway.ts`).
- Budget exhausted → Vorschlag wird `deferred`, nie still ausgeführt.

## Rollback

Vor jeder Aktion: Snapshot des betroffenen Zustands (PID-Liste, Prozessbaum,
DB-Session-ID, Port-Owner, Worktree-HEAD). Rollback ist deterministisch und
wird im Audit protokolliert. Kein Rollback fremder Zustände.

## Schutz vor Selbstmodifikation

Folgende Dateien/Bereiche sind für autonome Änderungen gesperrt:
`STOP`, `docs/completion/controller/state.json`, Governance-Dokus, `.env`,
Security-/Approval-Code, Freigabe-Dateien. Änderungen nur durch Mensch.

## Laufzeit

Controller und Supervisor bleiben gestoppt; das STOP-Flag bleibt gesetzt.
Phase I darf nicht gestartet werden, bevor die Freigabe und eine kontrollierte,
auditierte Startsequenz vorliegen.
