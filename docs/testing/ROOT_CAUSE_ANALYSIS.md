# Root Cause Analysis – Phase E.1 Full-Suite-Instabilität (2026-11-26)

## Symptom

- Sequenzielle Full-Suite mit gemeinsamer Entwicklungs-DB: **63/64 Dateien, 261/262 Tests** grün.
- Flaky Test: `tests/orchestration.test.ts` > „runs CEO orchestration and returns a valid hierarchy“.
- Assertionschritt: `tests/helpers/orchestration-engine.ts:21` wartet auf `waiting_for_approval`, sieht aber `running`.
- Isoliert lief derselbe Test grün; die Ursache war zunächst ungeklärt (alte Notiz: „Hypothesis (unverified)“).

## Vorgehen

1. **Messbarkeit zuerst.** Env-gesteuerte Instrumentierung via `QA_TRACE_FILE`
   (`src/qa-trace.ts`) in `lib/db.ts`, `src/engine.ts`, `src/orchestration.ts`,
   `src/orchestration-lease.ts`, `src/jobs.ts`, `src/index.ts`. Es werden nur
   IDs, Zustände, Dauern und fehlerhafte Codes geloggt — **keine Secrets,
   Tokens oder Lease-Token**.
2. **Stufenweise Reproduktion mit einem Worker:** zuerst der betroffene Test,
   dann die betroffenen Testdateien gemeinsam, erst danach die vollständige Suite.
   - `tests/orchestration-lease-recovery.test.ts`: **1/1 PASS**. Zwei Driver
     für denselben Run; Takeover korrekt gefenced (Epoch 1 → 2), alter Driver
     endet mit `ORCHESTRATION_LEASE_LOST`.
   - `tests/orchestration-lease-recovery.test.ts`, `tests/engine-hardening.test.ts`,
     `tests/engine.test.ts`, `tests/browser-gateway.test.ts` zusammen:
     **4/4 Dateien, 22/22 PASS**.
3. **Isolierte Dauerhafte QA-Runtime** `npm run qa:full` (`scripts/qa-full.mjs`)
   mit `flock`, `--maxWorkers=1`, temporärer PostgreSQL-Instanz und Watchdog.
   Zwei vollständige Läufe: **262/262 PASS** (64/64 Dateien).

## Nachgewiesene Ursache

Kein nachgewiesener Orchestrierungs-Codefehler. Die Instabilität kam aus der
**gemeinsamen Umgebung**:

- **Konkurrierende Engine-Poller.** Ein UGC-Dev-Server mit `AUTOMATION_ENGINE=on`
  pollt alle 3 s dieselbe Datenbank und konkurriert mit dem Testprozess um
  Jobs und Leases. `activeOrchestrations` in `src/engine.ts` ist prozesslokal
  und fenced nicht über Prozesse hinweg; die persistente DB-Lease in
  `src/orchestration-lease.ts` tut es. Die Trace-Daten zeigen, dass diese
  Fencing korrekt funktioniert.
- **Instabile Browser-Dienstverfügbarkeit.** Mit gesetztem
  `BROWSER_RUNTIME_URL` erwartet `tests/browser-gateway.test.ts`
  Verfügbarkeit; ohne laufenden Dienst meldet `/api/browser/status` korrekt
  `available=false`. Auch das ist ein Umgebungs-, kein Codefehler.
- **Geteilte Entwicklungs-DB mit akkumuliertem Zustand** erhöhte die
  Timing-Varianz. Ein erster Isolationsversuch über ein Prisma-Schema
  scheiterte mit **28/262 Fehlern**: Prisma 7 benötigt für Migrationen
  `?schema=...`, der Prisma-Client schrieb trotz `search_path` weiter in
  `public`. Deshalb läuft `qa:full` jetzt gegen eine eigene temporäre
  PostgreSQL-Instanz mit Rolle `ugc_os_app` (`NOSUPERUSER`, `NOBYPASSRLS`).

## Messdaten (beide erfolgreichen Full-Suites)

| Messgröße | Lauf 17:33Z | Lauf 17:42Z |
|---|---|---|
| Engine-Ticks / Overlaps | 29 / 0 | 29 / 0 |
| Maximale Tick-Dauer | 2110 ms | 2070 ms |
| Kicks / Overlaps | 9 / 0 | 9 / 0 |
| Driver-Starts / `no_lease` | 11 / 0 | 11 / 0 |
| Lease-Claims (erfolgreich / verweigert) | 12 (11 / 1) | 12 (11 / 1) |
| Maximale Lease-Query | 19 ms | 19 ms |
| DB-TX Wartezeit p50 / p95 / max | 4 / 13 / 128 ms | 3 / 15 / 133 ms |
| DB-TX Dauer p50 / p95 / max | 25 / 106 / 471 ms | 25 / 110 / 545 ms |
| `bounded_wait` | 0 | 0 |
| Job-Claims (erfolgreich / verweigert) | 66 (65 / 0) | 66 (65 / 0) |
| State-Transitions / Approvals | 15 / 3 | 15 / 3 |
| Aktive Handles am Ende | 3 Pipe, 1 TCP, 1 Timeout | 3 Pipe, 1 TCP, 1 Timeout |

Die einen verweigerten Lease-Claims und der eine `orchestration.driver.error`
sind erwartete Negativpfade des Takeover-Regressionstests. `db_tx.error`
enthält erwartete Fehler wie `AI_BUDGET_EXCEEDED` und
`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`, keine Infrastrukturfehler.

## Widerlegte Hypothesen

- **Reentranz / doppelte Ticks:** keine Überlappung bei 29 Ticks und 9 Kicks.
- **Deadlock / unbegrenztes Warten:** `bounded_wait = 0`, maximale
  DB-Wartezeit 133 ms.
- **Verwaiste Leases:** alle leased Driver wurden freigegeben; die einzige
  Ablehnung ist das beabsichtigte Fencing.
- **Orchestrierungs-Codefehler:** der Takeover funktioniert über Epochen und
  verhindert Überschreiben durch einen alten Worker.

## Entscheidung

Keine Änderung an der Produktions-Orchestrierungslogik. Die Instrumentierung
bleibt dauerhaft, ist aber inaktiv ohne `QA_TRACE_FILE`. Die Regression
(`tests/orchestration-lease-recovery.test.ts` und
`tests/helpers/orchestration-engine.ts` mit `orchestrationsResumed === 1` und
`leaseOwner === null`) blieb unverändert. Reproduzierbar ist der grüne Lauf
ausschließlich über `npm run qa:full`.
