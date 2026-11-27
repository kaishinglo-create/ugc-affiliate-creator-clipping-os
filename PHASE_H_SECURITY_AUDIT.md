# Phase H — Security Audit (2026-11-27, abgeschlossen)

Scope: Branch `feature/phase-h-live-publishing-2026-11-27`, uncommitteter Stand
mit den Ergänzungen aus dieser Sitzung. Read-only Prüfung; keine `.env`-Werte
wiedergegeben. Subagent-gestützte MECE-Gap-Analyse sowie manuelle Verifikation.

## Geschlossene Findings

| ID | Finding | Fix | Nachweis |
|---|---|---|---|
| H-S1 | Checksum war nur Freiform-String, nie gegen Medienbytes geprüft | `verifyClipChecksum()` in `src/publishing.ts` berechnet SHA-256 der echten Datei; Gate lehnt ab bei Abweichung | Code-Review, `tests/phase-h-security.test.ts` |
| H-S2 | Kill-Switch nur beim Claim, nicht unmittelbar vor der Extern-Aktion | separater Preflight in `processPublishingJob()` mit frischer Workspace-Transaktion | Code-Review |
| H-S3 | Unbekanntes Upload-Ergebnis (`NETWORK_ERROR`) wurde blind retried | `UPLOAD_STATUS_UNKNOWN`, `retryable:false`, Audit-Hinweis auf manuellen Statusabgleich | Code-Review |
| H-S4 | `recordPublishingConnectionOutcome` außerhalb des Settlement-Try | in `try/catch`, Settlement bleibt autoritativ | Code-Review |
| H-S5 | Approval ohne Ablauf/Widerruf | `Approval.expiresAt/revokedAt` + Migration `20261127130000`, `POST /api/approvals/:id/revoke`, Gate prüft beides | Migration lokal angewendet, Test |
| H-S6 | Zielaccount konnte nach Freigabe deaktiviert werden | Preflight prüft `publishingAccount.status=ACTIVE` unmittelbar vor Upload | Code-Review |
| H-S7 | Keine Budgetkontrolle für Publishing | harter Tages-Cap über `publishing_attempt`-Audit-Events (`PUBLISHING_MAX_DAILY_ATTEMPTS_PER_WORKSPACE`) | Code-Review |
| H-S8 | Zeitzonen-Konversion DST falsch | `publishingLocalTimeToUtc` vergleicht jetzt Ortszeit mit Ziel-Ortszeit; nicht existierende Zeiten → `null` | Test `converts summer and winter local times correctly` |
| H-S9 | Affiliate-Webhooks ohne Signatur | HMAC-SHA256 über `timestamp.rawBody`, 5-Minuten-Fenster, timing-sicherer Vergleich, Dedup via `externalEventId` | `src/affiliate-webhook.ts`, `tests/phase-h-security.test.ts` |
| H-S10 | `payoutReference`/`paidAt` nur im Audit | werden jetzt in `AffiliateConversion` persistiert | Test `revoking an approval blocks enqueue and persists payout reference and timestamp` |
| H-S11 | PreParsing-Hook doppelte Antwort | Async-Form ohne `done`-Callback korrigiert | Testlauf 4/4 |

## Restrisiken / extern blockiert

- **Keine echten Plattform-Credentials**: YouTube/TikTok/Instagram-Adapter sind
  echte offizielle Flows mit injiziertem Fetch, aber `LIVE_VERIFICATION_PENDING`.
  Kein Upload, keine Plattformbestätigung.
- **DNS-Rebinding-TOCTOU** und Redirect-Final-URL-Prüfung wurden in H-S12/H-S13
  geschlossen (gepinnte DNS-Auflösung, manuelle Redirects, Credential-Stripping).
  Eine echte Live-Prüfung gegen Provider-Hosts steht weiterhin aus.
- **Symlink-Eindämmung** wurde in H-S14 geschlossen (`realpath`, `O_NOFOLLOW`,
  Descriptor-Read); verifiziert mit lokalen Test-Doubles, nicht live.
- **Affiliate-Netzwerk-Webhooks** nutzen einen serverseitigen HMAC-Secret;
  echte Netzwerk-Signaturschemata sind extern blockiert. Consent/Retention/
  Purge sind als technische Bausteine implementiert (`/api/privacy/*`), aber
  keine Rechtskonformitätserklärung.
- **Keine Vier-Augen-Freigabe**: Freigabe und Queue Creation können vom selben
  OWNER/ADMIN erfolgen. Die manuelle Entscheidung ist vorhanden, aber keine
  zweite Person erforderlich.

## Zusätzlich geschlossene Findings (Korrekturlauf)

| ID | Finding | Fix | Nachweis |
|---|---|---|---|
| H-S12 | Kein IP-Pinning / DNS-Rebinding-Schutz im Publishing-Pfad | Wiederverwendung von `resolvePinnedTarget`/`createPinnedAgent` aus Phase G; pro Hop validierte Adresse, TLS/SNI unverändert | `src/publishing-adapters.ts`, `tests/phase-h-hardening.test.ts` |
| H-S13 | Redirects nicht validiert, Authorization konnte an fremde Hosts fließen | `redirect:'manual'`, maximal 3 Hops, jede Ziel-URL erneut validiert, Credential-Header bei Origin-Wechsel entfernt | Code + Test |
| H-S14 | Medienlesen folgte Symlinks; TOCTOU zwischen Prüfung und Read | `realpath`-Grenze + `open(O_RDONLY|O_NOFOLLOW)` + Read aus File-Descriptor | `tests/phase-h-hardening.test.ts` |
| H-S15 | Webhook-Signatur nicht an Workspace/Provider gebunden | HMAC über `timestamp.workspaceId.provider.rawBody`; Replay über Workspace-Grenze → 401 | `tests/phase-h-hardening.test.ts` |
| H-S16 | Raw-Body konnte unbegrenzt Speicher fressen | 256-KiB-Cap direkt im PreParsing-Hook (`413 WEBHOOK_TOO_LARGE`) | Test |
| H-S17 | Mehrdeutige Sommerzeit still einer Seite zugeordnet | `publishingLocalTimeToUtc` liefert für nonexistent/ambiguous Zeiten `null` | Tests in beiden Testdateien |

Restrisiken: echte Provider-Insights-Daten (Request-/Parse-Layer ist lokal
vorhanden), Vier-Augen-Governance (lokal nicht aktiv), echte Netzwerk-
Signaturschemata, Per-Plattform-Quota-Verbrauch und rechtliche GDPR-
Konformität. Die genannten Punkte benötigen externe Provider-/Rechtsgrundlagen.

## Governance

- Controller/Supervisor gestoppt, STOP-Flag vorhanden (`docs/completion/controller/STOP`).
- Keine echten Uploads/Veröffentlichungen, kein Deployment, kein Push/Merge/PR.
- Keine Secrets in Code, Logs, Frontend oder Doku; Test-Passwords sind Test-Fixtures.
- Während der Zwischenabnahme wurden **konkurrierende lokale Prozesse**
  beobachtet (`tests/phase-h-regression.test.ts` und ein QA-Lauf stammten nicht
  aus dieser Sitzung). Sie wurden kontrolliert per SIGTERM beendet, nachdem der
  Arbeitsstand erneut gesichert war (`/tmp/opencode/phase-h-recovery/pre-termination/`).
  Der betroffene QA-Lauf wurde verworfen, weil währenddessen Quelldateien
  verändert wurden. Die hinzugekommenen Regressionstests wurden geprüft und
  unverändert in die Gesamtsuite übernommen. Seit dem Source-Freeze
  (`docs/testing/evidence/phase-h/source-freeze.json`) gab es keine
  konkurrierenden Schreibprozesse mehr.
