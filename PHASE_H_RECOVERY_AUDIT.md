# Phase H — Recovery & Bestandsaudit (H.0)

Datum: 2026-11-27 · Branch: `feature/phase-h-live-publishing-2026-11-27` · Baseline: `main` `55d28c4`

## Herkunft der uncommitteten Änderungen

- Die Änderungen stammen nicht aus dieser Sitzung. Sie wurden von einem anderen
  lokalen Prozess nach dem Phase-G-Handoff erzeugt (Datei-Mtimes 2026-11-27
  07:26–07:49 +0100 für `src/affiliate.ts`, `src/publishing.ts` und die Migration;
  `scripts/e2e.mjs` 18:33 +0100). `git reflog` zeigt nur den Checkout von `main`
  auf den Phase-H-Branch, keine entsprechenden Commits.
- Der Phase-G-Acceptance-Report dokumentiert bereits, dass andere lokale
  Prozesse während der Abnahme Commits erzeugt haben; derselbe Mechanismus hat
  hier den Phase-H-Startvorschlag hinterlassen.
- Es wurde **kein** Commit, Push, Merge oder Force-Override durchgeführt. Alle
  Änderungen wurden unverändert übernommen.

## Sicherung ohne Commit

- `/tmp/opencode/phase-h-recovery/phase-h-working-tree.patch` — vollständiger
  Diff (5.276 Zeilen, inkl. Binäranteile).
- `/tmp/opencode/phase-h-recovery/tracked-files.tgz` — Schnappschuss der 12 geänderten
  Dateien.
- `/tmp/opencode/phase-h-recovery/migration.sql`, `e2e.mjs` — exakte Kopien der
  untracked Dateien.
- Wiederherstellung jederzeit via `git apply` bzw. Entpacken ohne Git-Commit
  möglich.

## Diskrepanz PHASE_H_PREPARATION.md vs. Realität

`PHASE_H_PREPARATION.md` erklärt: „prepared, not started, kein Phase-H-Code
geschrieben". Das war zum Zeitpunkt des Phase-G-Handoffs korrekt. Danach hat der
externe Prozess eigenständig ~1.852 Zeilen Phase-H-Code produziert. Die
Vorbereitungsdatei ist damit historisch, nicht mehr aktuell; sie wird nicht
gelöscht, sondern im laufenden Dokumentationspaket (H.8) mit einem
Übernahmehinweis versehen. **Keine redundante Neuentwicklung** — vorhandener
Code wird geprüft und ergänzt.

## MECE-Bestandsmatrix (Kurzfassung; Vollversion: PHASE_H_FEATURE_MATRIX.md)

| Paket | Vorhanden | Fehlend / kritisch |
|---|---|---|
| H.0 | uncommitteter Stand, Migration | Recovery-Doku (hier), Feature-Matrix |
| H.1 | 3 Modelle + RLS + Indizes + UTM/checksum-Felder | FKs/CHECKs, Frisch-/Upgrade-Test, Backup/Restore |
| H.2 | Queue, Leases, Backoff, DLQ, Fencing, Zeitzonen | Kill-Switch vor Upload, Reconcile, Budget, Schedule-Lifecycle, Settlement-Bruch |
| H.3 | Binding-Hash, Rollen, Redaction, Crypto-Store | Approval-Ablauf/Widerruf, Checksum gegen Bytes, Redirect-/Symlink-Härtung |
| H.4 | YouTube/TikTok/Instagram echte Flows | Statusvokabular, Analytics/Insights, Quota, Chunk-Resume |
| H.5 | Links, UTM, Revenue-Dimensionen, Payout-State | Webhook-Signatur, Consent, payoutReference/PaidAt, Dedup |
| H.6 | 15 Tabs, lesende Phase-H-Panels | alle schreibenden Aktionen, Agenten-Verdrahtung |
| H.7 | 327 Baseline-Tests | 0 Phase-H-Tests, QA-Läufe, Browser-/Security-Gates |
| H.8 | Masterprompt, Tasks | 5 geforderte Dokumente, Statusupdates |

## Geprüfte Module

`src/publishing.ts` (Engine/Queue/Schedules), `src/publishing-adapters.ts`
(echte Provider-Flows), `src/affiliate.ts`, `src/analytics-sources.ts`,
`src/api-integration-center/service.ts` (Credential-Resolver/Refresh),
`src/index.ts` (alle neuen Routen), `src/engine.ts`, `src/quality-gate.ts`,
`prisma/schema.prisma` + Migration, `public/app.js` (15 Tabs), `scripts/e2e.mjs`.

## Status

**PHASE_H_IMPLEMENTATION_IN_PROGRESS** — kein vorhandener Arbeitsstand verworfen,
keine redundante Implementierung begonnen.
