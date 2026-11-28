# Phase I — Security Audit (2026-11-28)

Scope: Branch `feature/phase-i-self-healing-self-improving`, read-only Review
und kontrollierte Tests. Keine Secrets in Code/Logs/Doku.

## Geschützte Invarianten

1. **Fremde Prozesse** werden nie automatisch beendet; alle INC-PH-01/02/06-Fälle
   sind `report_only`.
2. **Fremde Datenbanktransaktionen** werden nie automatisch gecancelt
   (INC-PH-03 → `report_only`).
3. **Freigabe**: jede Recovery-Aktion braucht ein `approved`-Approval mit
   `entityType=recovery_run`, passender `entityId`, nicht widerrufen und nicht
   abgelaufen (`src/recovery-engine.ts`).
4. **Kill-Switch** wird unmittelbar vor der Extern-Aktion geprüft.
5. **Budget**: atomare Tages-Cap-Logik über Audit-Events
   (`PHASE_I_MAX_RECOVERIES_PER_WORKSPACE_DAILY`, Default 20).
6. **Sandbox**: standardmäßig deaktiviert; nur explizites
   `PHASE_I_SANDBOX_ENABLED=1`; Worktree unter `/tmp/opencode/phase-i-sandboxes`;
   `.env` wird nicht in die Sandbox kopiert; keine Commit/Push/Merge-Aufrufe.
7. **Review-Gate**: `runSandboxTests` muss bestehen, bevor `reviewSandbox`
   überhaupt eine Entscheidung akzeptiert.
8. **Workspace-RLS**: `Incident` (erweitert), `RecoveryRun`, `ImprovementTask`,
   `SandboxRun` haben FORCE RLS + Policy; alle Zugriffe laufen über
   `withWorkspaceTransaction`.
9. **Kein Paid-Fallback**, keine Mockdaten im Produktivpfad, keine echten
   Veröffentlichungen, kein Deployment.

## Findings

- **Behoben (Konstruktionsfehler)**: initial wurde ein doppeltes `Incident`-Modell
  angelegt und die bestehende Phase-12-Tabelle ersetzt. Vor der Abnahme korrigiert:
  bestehendes Modell wird erweitert (`fingerprint`, `kind`, `evidence`,
  `diagnosis`, `detectedAt`), Migration `20261128010000` ist additiv.
- **Offen (extern)**: echte OpenCode-CLI-Ausführung in der Sandbox wurde nicht
  gegen einen echten Free-Quota-Provider verifiziert; Sandbox bleibt standardmäßig
  deaktiviert. Dies ist kein lokaler Blocker.

## Vertiefte Sandbox-Prüfung (Nachbesserung)

Ein Git-Worktree allein ist **keine** wirksame Sandbox. Auf dieser Hardware
stehen keine OS-Namespaces bzw. seccomp zur Verfügung. Der Coding-Agent bleibt
daher standardmäßig fail-closed deaktiviert (`PHASE_I_SANDBOX_ENABLED`), und
die Grenzen werden durch `src/sandbox-policy.ts` ergänzt:

- **Prozessisolation**: nicht verfügbar → kein Agentenprozess ohne Opt-in.
- **Dateisystemisolation**: Worktree-Root + `realpath`-Prüfung gegen
  Symlink-Escapes, Pfad-Traversal und gesperrte Governance-Pfade
  (`STOP`, `.env`, `recovery-engine.ts`, `quality-gate.ts`, …).
- **Netzwerk**: keine Agenten-Netzwerkaufrufe; nur lokale Testkommandos.
- **Ressourcen**: harte Timeouts (10–300 s) und Ausgabe-Begrenzung.
- **Secrets**: keine Übernahme produktiver `.env`-Werte in die Sandbox.
- **Git**: nur lesende Subkommandos (`status`, `diff`, `log`, `rev-parse`);
  `commit/push/merge/checkout/reset/clean` blockiert.
- **Patch-Übernahme**: nur nach bestandenen Sandbox-Tests und expliziter
  menschlicher Freigabe; keine automatische Integration.

Nachweise: `tests/phase-i-deep.test.ts` (Symlink-Escape, Traversal,
Governance-Pfad, Git-Schreibblockade, Command-Allowlist, Capabilities).

## Vertiefte DB-Prüfung

`scripts/verify-phase-i-db.mjs`: expliziter Phase-H→I-Upgrade, neue Spalten
und Tabellen, FORCE RLS (3/3), partielle Dedup-Unique, Workspace-Isolation
über eine Nicht-Superuser-Rolle, Persistenz nach Neustart und
Schema-Backup/Restore der vier Tabellen — alle Checks PASS.

## Governance

Controller/Supervisor gestoppt, STOP-Flag gesetzt, kein Neustart, kein
Commit/Push/PR/Merge ohne separate Freigabe.
