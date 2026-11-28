# PHASE I — MASTERPROMPT (vorbereitet, nicht gestartet)

Self-Healing · Self-Improving · Sichere Autonomie

## Freigabe

Phase I ist **vorbereitet**. Die Implementierung erfordert eine separate,
ausdrückliche Freigabe. Kein Code, kein Controller-Neustart, kein Deployment.

## Ausgangslage

- Phase H ist in `main` gemergt (PR #33, Merge-Commit `5c41045`), Post-Merge-CI
  `46086634835` grün, 354/354 Tests, 43+ Migrationen.
- Externe Live-Verifikation bleibt separat blockiert (Credentials, OAuth-Reviews).
- Controller/Supervisor gestoppt, STOP-Flag gesetzt.

## Reale Ausgangsfälle für Self-Healing (aus Phase G/H beobachtet)

Diese Fälle sind die verbindlichen Startfälle — keine theoretischen Szenarien:

1. **Konkurrierende Coding-Prozesse**: parallele Agenten schrieben in derselben
   Arbeitskopie (z. B. `public/app.js`, `scripts/verify-phase-h-db.mjs`), wodurch
   Source-Freeze-Manifeste drifteten und QA-Läufe verworfen werden mussten.
2. **Portkonflikte**: `EADDRINUSE` auf :3000 und :3031 durch doppelte Dev-/MECE-
   Starts; Dienste meldeten `http=200`, waren aber stale Prozesse.
3. **Hängende Datenbanktransaktionen**: `idle in transaction` über 11 Minuten
   auf `ugc_os`, was Browser-Timeouts und `bootstrap.version = nicht erkannt`
   verursachte.
4. **QA-Watchdog-Timeouts**: stale PostgreSQL-Cluster und konkurrierende
   `vitest`-Worker führten zu abgebrochenen Läufen (Exit 143).
5. **Source-Drift während QA**: Hash-Manifest änderte sich zwischen Freeze und
   Lauf → Lauf darf nicht als Abnahme zählen.
6. **Preflight blockiert**: UGC/Control liefen während eines isolierten QA-Laufs;
   `qa:full` verweigerte korrekt das Stoppen fremder Prozesse.

## Arbeitspakete

### I.0 Recovery & Governance
Bestandsaufnahme, Freeze, Rollen, Freigabegrenzen, STOP-Flag, Audit-Baseline.

### I.1 Incident-Modell
Strukturierte Incidents aus echten Signalen: Prozess-Registry, Port-Scan,
`pg_stat_activity`, QA-Watchdog, Freeze-Hash, Health-Probes. Keine erfundenen
Incidents.

### I.2 Self-Healing — Erkennung
Klassifikation: `foreign` vs. `own`, `transient` vs. `persistent`,
`safe_to_remediate` vs. `approval_required`.

### I.3 Self-Healing — Recovery
Kontrollierte Maßnahmen: eigene Kinder stoppen, eigene Transaktionen canceln,
stale Cluster aufräumen, Freeze-Drift abbrechen, Rollback. Fremde Prozesse
nie automatisch beenden.

### I.4 Self-Improving — Vorschläge
Ableitung aus echten Audit-Events und Incident-Daten; Vorschläge mit Evidenz,
kein simuliertes Wissen, keine bezahlten Modelle.

### I.5 Isolierte Sandbox & Review-Agent
Änderungsvorschläge nur in Sandbox/Worktree; automatische Tests; Review-Agent;
kein Direkt-Commit in `main`.

### I.6 Budget, Rollback, Audit
Harte Budgets, every action audited, Rollback-Pfad vor jeder Autonomie-Aktion.

### I.7 Tests & Abnahme
Unit/Integration/Security; zwei isolierte qa:full; Browser-Gates; real
reproduzierte Incidents aus der Liste oben.

### I.8 Dokumentation & Übergabe
Roadmap/Tasks/STATE/NEXT_SESSION, Abschlussstatus, Phase-J-Vorbereitung.

## Verbindliche Regeln

- Nur kostenlose Modelle/Dienste; kein Paid-Fallback.
- Keine Fake-Erfolge, keine Mock-Daten im Produktivbetrieb, keine Tests abschwächen.
- Kein Commit/Push/PR/Merge/Deploy/Publishing ohne Freigabe.
- Controller/Supervisor bleiben gestoppt, STOP-Flag bleibt gesetzt.
- Keine Selbstmodifikation von Governance-Dateien ohne Mensch.
- Phase I nicht starten ohne separate Freigabe.
