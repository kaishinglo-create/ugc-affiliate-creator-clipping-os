# Phase H — MECE Feature Matrix

Stand: H.0–H.8 lokal implementiert; Finalabnahme abgeschlossen (`READY_FOR_COMMIT`). Legende:
**V** vorhanden · **T** teilweise · **F** fehlt · **X** fehlerhaft.
`V` bedeutet *lokal implementiert und geprüft*, nicht *extern live verifiziert*.
Ohne echte Plattform-Credentials bleibt `EXTERNAL_LIVE_VERIFIED: none`.

| ID | Fähigkeit | Status | Ort / Nachweis |
|---|---|---|---|
| H.1.01 | `AffiliateLink` Modell + RLS | V | `prisma/schema.prisma`, Migration `20261127120000` |
| H.1.02 | `PublishingAccount` Modell + RLS | V | Schema/Migration, `src/publishing.ts::upsertPublishingAccount` |
| H.1.03 | `PublishingSchedule` Modell + RLS | V | Schema/Migration, `src/publishing.ts::createPublishingSchedule` |
| H.1.04 | `QualityReport.checksum` | V | `src/quality-gate.ts` (SHA-256 echter Bytes), Re-Hash im Gate |
| H.1.05 | UTM-Parameter | V | `src/affiliate.ts::normalizeUtm/appendUtm`, Click-Route |
| H.1.06 | Kampagnen-/Creator-/Plattform-Zuordnung | T | IDs an Links/Clicks/Conversions; keine FKs, aber Validierung + RLS |
| H.1.07 | `externalEventId`, `commissionCents` | V | Migration, Routes, `affiliateCommissionCents` |
| H.1.08 | Workspace-Isolation / FORCE RLS | V | Migration Policies, `withWorkspaceTransaction`, Isolationstests |
| H.1.09 | Indizes / Unique / Dedup | V | Migration, `tests/phase-h-regression.test.ts` |
| H.1.10 | Referenzielle Integrität / CHECKs | V | Migration `20261127140000`, `scripts/verify-phase-h-db.mjs` (7/7 Checks) |
| H.1.11 | Frisch-DB + Upgrade + Backup/Restore | V | `qa:full` Frisch-DB, Upgrade 41+3 Migrationen, Schema-Restore; Daten-Dump benötigt BYPASSRLS |
| H.2.01 | Persistente Queue / Leases / Heartbeat / Fencing | V | `src/jobs.ts`, `src/publishing.ts`, `heartbeatJob` |
| H.2.02 | Publishing-Kalender + Zeitzonen | V | `publishingLocalTimeToUtc` (IANA/DST), `PublishingSchedule`, Tests |
| H.2.03 | Idempotenz / Retry / Backoff / DLQ | V | `createJob`, `classifyPublishingFailure`, `retryPublishingDeadLetter` |
| H.2.04 | Rate Limits | T | Circuit Breaker/Cooldown/Quota-Read; echtes API-Quota extern blockiert |
| H.2.05 | Kill-Switch unmittelbar vor Upload | V | Preflight-Transaktion vor `executeLivePublishing`, Tests |
| H.2.06 | Tages-Cap für Publishing-Versuche | V | `PUBLISHING_MAX_DAILY_ATTEMPTS_PER_WORKSPACE`, Audit-Zähler |
| H.2.07 | Unbekanntes Upload-Ergebnis | V | `UPLOAD_STATUS_UNKNOWN`, `retryable:false`, Manual-Reconcile-Hinweis |
| H.2.08 | Settlement-Transaktionssicherheit | T | Workspace-Transaktionen; kein verteilter Commit mit Plattform |
| H.2.09 | Stale/Crash Recovery, Parallelität | V | `recoverStalePublishingSchedules`, `enqueueDuePublishingSchedules`, Tests |
| H.3.01 | Binding-Hash (Quality→Account→Parameter) | V | `publishingBindingHash`, `publishingApprovalEntityIdForBinding`, v2-Payload |
| H.3.02 | OWNER/ADMIN, Workspace-Scope | T | `requireOperatorRole`, RLS; keine Vier-Augen-Freigabe |
| H.3.03 | Approval-Ablauf / Widerruf | V | `pending`→menschliche Entscheidung, `expiresAt`/`revokedAt`, Revoke-Route |
| H.3.04 | Checksum gegen tatsächliche Bytes | V | Quality-Gate-Hash + Re-Hash im Freigabegate |
| H.3.05 | Credential-Verschlüsselung / Redaction | V | API Integration Center, AES-256-GCM, `redactText` |
| H.3.06 | Token-Refresh | T | Persistenz echter Refresh-Antworten; nur live mit Token-Endpoint prüfbar |
| H.3.07 | SSRF / DNS-Rebinding / Redirect | V | `resolvePinnedTarget`/`createPinnedAgent`, manuelle Redirects, Credential-Stripping |
| H.3.08 | Pfad-/Symlink-Eindämmung | V | `realpath` + `open(O_NOFOLLOW)` + Read aus Descriptor |
| H.3.09 | Race / Replay / Kill-Switch vor Extern | T | Dedup + Preflight; Last-Test mit echten Plattformen offen |
| H.4.01 | YouTube Data API Resumable Upload | T | Offizieller Adapter, `#shorts`; kein Live-Upload ohne Credentials |
| H.4.02 | TikTok Content Posting API | T | Offizieller Init/Status-Flow; kein Live-Upload ohne Credentials |
| H.4.03 | Instagram Graph Reels | T | `media_type: REELS`; kein Live-Upload ohne Credentials |
| H.4.04 | OAuth / Token-Refresh | T | Flows/Persistenz; App-Reviews und Credentials extern offen |
| H.4.05 | YouTube Analytics / TikTok Creator / IG Insights | T | `src/provider-analytics.ts`: dokumentierte Request-/Parse-Funktionen, SSRF-/Body-Gate, `/api/publishing/provider-analytics`; keine Live-Daten |
| H.4.06 | Ehrliche Statuswerte | V | `NOT_CONFIGURED`, `CREDENTIALS_ONLY`, `LIVE_VERIFICATION_PENDING` |
| H.4.07 | Quota-Management / App-Review-Hinweise | T | Zustands-/Cap-Logik lokal; App-Review und echte Quota extern offen |
| H.5.01 | Affiliate-Links + UTM + Disclosure | V | `/api/affiliate/links`, Redirect, `X-Affiliate-Disclosure` |
| H.5.02 | Attribution / Payout-State-Machine | V | `src/affiliate.ts`, Payout-Route, persistierte Referenz/Zeit |
| H.5.03 | Revenue pro Clip/Creator/Plattform/Kampagne | V | `summarizeAffiliateRevenue`, `/api/affiliate/revenue` |
| H.5.04 | Webhook-Verifikation | V | HMAC über `timestamp.workspaceId.provider.rawBody`, 5-Min-Fenster, 256 KiB; echte Netzwerkschemata offen |
| H.5.05 | GDPR-Consent / authentifizierte Conversion | T | `/api/privacy/consent`, `/api/privacy/purge`, `retentionReport`; technisch, keine Rechtskonformität behauptet |
| H.5.06 | `payoutReference` / `paidAt` Persistenz | V | Schema, Payout-Route, Tests |
| H.5.07 | NO_ROWS / NOT_CONFIGURED | V | `src/analytics-sources.ts`, Missing-Marker, Revenue-Route `null` |
| H.6.01 | 15 Tabs + lesende Phase-H-Panels | V | `public/app.js` in `calendar`, `agents`, `analytics`, `campaigns` |
| H.6.02 | Schreibende UI-Aktionen | V | Accounts, Approvals, Schedules, Links, Retry, Revoke, Disable |
| H.6.03 | Department/Agenten-Verdrahtung | T | `phaseHAgentContext` für 8 Rollen in `src/orchestration.ts`; keine autonomen Publishing-/Affiliate-Agenten |
| H.6.04 | Leerzustände / Fehleranzeigen | V | `h5Table`, Blocker, Missing-Marker; `h5-*` Panels auch ohne Daten sichtbar; Frontend-Acceptance 23/23, MECE-Browsercheck 30/30 |
| H.7.01 | 327 Baseline-Tests | V | unverändert, keine Testabschwächung (`git diff -- tests` leer) |
| H.7.02 | Phase-H-Tests | V | 26 neue Tests in 6 Dateien (2+2+5+4+9+4) |
| H.7.03 | Zwei isolierte `qa:full`-Läufe | V | 353/353 + 353/353, 87/87 Dateien, identischer Stand `0fa61ade…` |
| H.7.04 | Browser-/Frontend-/Security-Gates | V | Playwright 9/9, Frontend 23/23, MECE 30/30, `verify:phase-g` passed, Secret-Scan 0 Treffer |
| H.8.01 | Masterprompt + Aufgabenliste | V | `PHASE_H_MASTERPROMPT.md`, `PHASE_H_TASKS.json` |
| H.8.02 | Recovery-Audit + Feature-Matrix | V | `PHASE_H_RECOVERY_AUDIT.md`, diese Datei |
| H.8.03 | Security-Report / Finalreport | V | `PHASE_H_SECURITY_AUDIT.md` (17 Findings), `PHASE_H_FINAL_ACCEPTANCE_REPORT.md` |
| H.8.04 | Statusdateien final aktualisiert | V | Roadmap/PROGRESS/STATE/Blockers/Finalreport auf `READY_FOR_COMMIT` abgeglichen |

## Fortschritt

- Von 55 Positionen: 41 lokal implementiert, 14 teilweise, 0 offen, 0 fehlerhaft.
  Externe Live-Verifikation ist bei allen Adapterpunkten ausdrücklich
  ausgenommen.
- Geschlossene Sicherheitsfindings H-S1 bis H-S17 siehe
  `PHASE_H_SECURITY_AUDIT.md`.
- Governance: Controller/Supervisor gestoppt, STOP-Flag gesetzt, kein Commit,
  Push, Merge, Deployment, Publishing oder Controller-Neustart ohne Freigabe.

## Nachweise der Finalabnahme

- Statisch: Typecheck, ESLint (0 Fehler/0 Warnungen), Build, `node --check` für
  alle geänderten Skripte/Frontend-Dateien: PASS.
- Datenbank: `scripts/verify-phase-h-db.mjs` 7/7 Checks (Upgrade 41+3,
  FORCE RLS, CHECKs, negative Provision abgelehnt, Schema-Restore), Report
  `docs/testing/evidence/phase-h/db-verification.json`.
- Secret-Scan: 4 geprüfte Werte, 520 Dateien, 0 Treffer (finaler Stand).
- Quellstand: `/tmp/opencode/phase-h-final-freeze.json`, Hash
  `0fa61ade0af5239c551d6028fea5979abcbdad1c56e4cbf71a7e77398322d16a` (33 Dateien).
- Tests: 327 Baseline + 26 neue Phase-H-Tests = 353 Tests in 87 Dateien.
  Zwei isolierte `qa:full`-Läufe: 353/353 + 353/353, Exit 0, Watchdog aus,
  RLS-Rolle ohne Superuser/BYPASSRLS. Browser-Gates: Playwright 9/9, Frontend
  23/23, MECE 30/30, `verify:phase-g` passed. Details im Finalreport.

## Bewusst offen / extern blockiert

- Keine echten Plattform-Credentials, OAuth-App-Reviews, echten Provider-Quota-
  Verbrauch oder externen Insights-Daten.
- Keine echten Affiliate-Netzwerk-Signaturschemata; die lokale HMAC-Variante ist
  kein Provider-Abkommen.
- Keine Vier-Augen-Governance (zweite Person), keine Rechtsberatung/GDPR-
  Konformitätserklärung, kein verteilter Commit mit Upload-Plattformen.

## Finalstatus

Alle H.0–H.8-Pakete sind `completed`. Finaler Source-Freeze `c08d35a4…`,
beide isolierten `qa:full`-Läufe 353/353 und 87/87 (Watchdog aus), Playwright
9/9, MECE 30/30, Frontend 23/23, echte Medienpipeline PASS, Secret-Scan
0 Treffer. **READY_FOR_COMMIT** — kein Commit, Push, PR, Merge, Deployment
oder Publishing ohne separate Freigabe.
