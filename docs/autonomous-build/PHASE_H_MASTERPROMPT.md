# PHASE H – MASTERPROMPT

Live Publishing, Affiliate Monetization & Analytics

## Offizielle Entwicklungsfreigabe

Hiermit erteile ich die ausdrückliche Freigabe zur vollständigen lokalen Implementierung und Abnahme von Phase H.

Ausgangslage:

- Repository: ugc-affiliate-creator-clipping-os
- Lokal: /home/kaishinglo/ugc-affiliate-creator-clipping-os
- Branch: feature/phase-h-live-publishing-2026-11-27
- Main-Baseline: 55d28c4
- Phase A bis G abgeschlossen und in main integriert.
- 327 bestehende Tests in 81 Vitest-Dateien.
- Playwright 9/9, MECE 27/27, Frontendabnahme 19/19.
- Rund 1.850 Zeilen uncommittete Phase-H-Implementierung vorhanden.
- Controller und Supervisor gestoppt.
- STOP-Flag bleibt gesetzt.

Speichere diesen vollständigen Masterprompt dauerhaft unter:

docs/autonomous-build/PHASE_H_MASTERPROMPT.md

Erstelle zusätzlich eine persistente Aufgabenliste PHASE_H_TASKS.json mit Aufgaben-ID, Status, Abhängigkeiten, Akzeptanzkriterien, Testnachweisen und Blockern.

Arbeite alle folgenden Pakete vollständig ab.

## H.0 – Recovery, Bestandsaudit und Governance

- Untersuche die Herkunft der vorhandenen uncommitteten Änderungen.
- Prüfe sämtliche Git-Diffs und untracked Dateien.
- Sichere den bestehenden Arbeitsstand lokal ohne Commit.
- Kläre die Diskrepanz zwischen PHASE_H_PREPARATION.md und tatsächlicher Implementierung.
- Erstelle eine vollständige MECE-Feature-Matrix.
- Identifiziere vorhandene, fehlende, unvollständige und fehlerhafte Funktionen.
- Prüfe alle bestehenden Publishing-, Affiliate-, Analytics-, API- und Agentenmodule.
- Aktualisiere den Status auf PHASE_H_IMPLEMENTATION_IN_PROGRESS.
- Keine redundanten Implementierungen und kein unkontrolliertes Verwerfen vorhandener Änderungen.

## H.1 – Datenbank und Migration

- Prüfe und vervollständige die Migration 20261127120000_phase_h_publishing_affiliate.
- Verifiziere: AffiliateLink, PublishingAccount, PublishingSchedule, QualityReport.checksum, UTM-Parameter, Kampagnenzuordnung, Creator-Zuordnung, Plattformzuordnung, externalEventId, commissionCents, Workspace-Isolation, RLS und FORCE RLS, Indizes und Constraints, Deduplizierung, referenzielle Integrität, Transaktionssicherheit.
- Teste eine frische Datenbank und das Upgrade einer bestehenden Phase-G-Datenbank.
- Sichere bestehende Datenbanken vor Änderungen. Prüfe Backup und Restore.
- Generiere den Prisma-Client regulär. Generierte Dateien niemals manuell bearbeiten.

## H.2 – Publishing Engine und Scheduler

Vervollständige die vorhandene Publishing-Architektur: persistente Publishing Queue, Publishing-Kalender, Veröffentlichungsplanung, Zeitzonen und Sommerzeit, Plattform- und Account-Zuordnung, Idempotenz, Retry und Backoff, Rate Limits, Dead Letter Queue, Stale Recovery, Crash Recovery, Worker-Leases, Heartbeats, Fencing, Parallelitätskontrolle, Kill-Switch, Audit Logging, Budgetkontrolle.

- Verhindere doppelte Veröffentlichungen, auch bei Prozessabstürzen, Timeouts und unbekanntem Upload-Ergebnis.
- Bei unklarem Providerstatus zuerst Statusabgleich durchführen, niemals blind erneut hochladen.

## H.3 – Security und menschliche Freigaben

Erzwinge serverseitig: Quality Report → Clip-Prüfsumme → Zielaccount → Veröffentlichungsparameter → menschliche Freigabe → Publishing Queue → autorisierter Upload → Plattformbestätigung → Audit Event.

Prüfe: OWNER-/ADMIN-Berechtigungen, Approval-Bypass, Manipulation freigegebener Inhalte, Account-Wechsel nach Freigabe, geänderte Metadaten, abgelaufene und widerrufene Freigaben, Workspace-übergreifende Zugriffe, Credential-Redaction, verschlüsselte Token-Speicherung, Token-Refresh, SSRF, DNS-Rebinding, Pfad-Traversal, Symlink-Angriffe, Race Conditions, Replay-Angriffe, Kill-Switch unmittelbar vor externen Aktionen.

- Jede relevante Änderung eines freigegebenen Inhalts erfordert eine erneute Freigabe.
- Keine tatsächlichen Uploads ohne separate ausdrückliche Zustimmung.

## H.4 – Offizielle Plattform-Adapter

Implementiere beziehungsweise vervollständige echte offizielle API-Adapter für:

- YouTube: YouTube Data API, Videos und Shorts, Resumable Upload, OAuth, Token-Refresh, Metadaten, Sichtbarkeit, Veröffentlichungsplanung, Upload-Status, Quota-Management, YouTube Analytics.
- TikTok: Offizielle Content Posting API, OAuth, Token-Refresh, Creator-Informationen, plattformgerechte Veröffentlichungsparameter, Upload-Initialisierung, Upload-Fortschritt, Statusabfrage, Plattformbeschränkungen und App-Review-Anforderungen.
- Instagram: Offizielle Meta-/Instagram-API, OAuth, Token-Refresh, berechtigte Instagram-Konten, Reels Publishing, Media Container, Container-Status, Veröffentlichung, Insights, Plattformbeschränkungen.

- Nutze das vorhandene API Integration Center und den verschlüsselten Credential Store.
- Prüfe die aktuellen offiziellen API-Dokumentationen.
- Keine Umgehung von Login, MFA, CAPTCHA, App-Reviews oder Plattformrichtlinien.
- Ohne Zugangsdaten beziehungsweise notwendige Freigaben bleiben die Statuswerte ehrlich: NOT_CONFIGURED, CREDENTIALS_ONLY, ADAPTER_NOT_IMPLEMENTED, LIVE_VERIFICATION_PENDING, CONNECTED nur nach erfolgreicher echter Providerprüfung.
- Keine erfundenen Uploads oder Plattformbestätigungen.

## H.5 – Affiliate-Monetarisierung und Revenue

Vervollständige die vorhandenen Affiliate- und Analytics-Module: Affiliate-Links, Affiliate-Netzwerk-Anbindungen, Produktzuordnung, Creator-Zuordnung, Kampagnenverwaltung, UTM-Tracking, Klick-Tracking, Conversion-Tracking, Attribution, Provisionen, Payouts, Revenue pro Clip, Revenue pro Creator, Revenue pro Plattform, Revenue pro Kampagne, Affiliate-Disclosure, Deduplizierung, authentifizierte Conversion-Events, Webhook-Verifikation, Replay-Schutz, datenschutzkonforme Datenerfassung.

- Provisionen ausschließlich aus tatsächlich gespeicherten oder durch autorisierte Anbieter bestätigten Werten berechnen.
- Keine erfundenen Klicks, Conversions, Einnahmen oder Provisionen.
- Fehlende Daten als NO_ROWS oder NOT_CONFIGURED kennzeichnen.

## H.6 – Frontend und Multi-Agent-Integration

Prüfe alle 15 vorhandenen Frontend-Tabs und sämtliche neuen Phase-H-Funktionen.

Vervollständige: Publishing-Kalender, Publishing Queue, Account-Verwaltung, Multi-Account-Verwaltung, Plattformstatus, Freigabecenter, Affiliate-Link-Verwaltung, Kampagnenverwaltung, Revenue-Dashboard, Performance pro Clip, Klick- und Conversion-Analytics, Fehleranzeigen, Retry-Aktionen, Agentenstatus, Kill-Switch, Credential-Status, leere Datenzustände.

- Alle Buttons und Aktionen müssen echte Backend-Funktionen verwenden.
- Keine Platzhalter, Demo-Daten oder funktionslosen Bedienelemente.
- Integriere die bestehenden Departments und Agenten: CEO, COO, Publishing, Affiliate, Research, API Integration, Analytics, Security.
- Bestehende Hierarchie und Architektur wiederverwenden. Keine redundanten Agenten-Runtimes erstellen.

## H.7 – Tests, Security und finale Abnahme

Erstelle neue Unit-, Integrations-, Security- und E2E-Tests für sämtliche neuen Funktionen.

Verbindliche Quality Gates: Typecheck PASS, ESLint PASS, Build PASS, alle bisherigen 327 Tests erhalten, neue Phase-H-Tests vollständig bestanden, zwei isolierte qa:full-Läufe auf identischem finalem Quellcodestand, Playwright vollständig bestanden, npm run verify:mece-browser, npm run verify:frontend, npm run verify:phase-g, Migrationstest, Backup-/Restore-Test, Workspace-Isolation und FORCE RLS, Publishing-Approval-Bypass-Tests, Retry- und Idempotenz-Tests, Crash-Recovery-Tests, Parallelitäts- und Fencing-Tests, Zeitzonen- und Sommerzeit-Tests, Credential- und Token-Redaction-Tests, vollständiger Secret-Scan, Security-Audit, vollständige Browserprüfung aller Frontend-Tabs.

- Keine bestehenden Tests entfernen, abschwächen oder zur Fehlerverdeckung überspringen.
- Test-Doubles ausschließlich in kontrollierten Tests.
- Keine externen Uploads oder Veröffentlichungen während der QA.
- Controller und Supervisor während der isolierten QA gestoppt halten.

## H.8 – Dokumentation, Fortschritt und Übergabe

Aktualisiere: MASTER_ROADMAP.md, MASTER_ROADMAP.json, PROGRESS.json, STATE.md, NEXT_SESSION.md, EXTERNAL_BLOCKERS.txt, PHASE_H_TASKS.json.

Erstelle: PHASE_H_MASTERPROMPT.md, PHASE_H_RECOVERY_AUDIT.md, PHASE_H_FEATURE_MATRIX.md, PHASE_H_SECURITY_AUDIT.md, PHASE_H_FINAL_ACCEPTANCE_REPORT.md, PHASE_I_PREPARATION.md.

Unterscheide konsequent: LOCAL_IMPLEMENTED, LOCAL_VERIFIED, GITHUB_INTEGRATED, EXTERNAL_LIVE_VERIFIED, EXTERNAL_BLOCKED.

Dokumentiere pro Arbeitspaket: implementierte Funktionen, betroffene Dateien, Tests, Testergebnisse, Security-Findings, offene Aufgaben, externe Blocker, tatsächlichen Fortschritt.

Phase I vollständig vorbereiten, aber noch nicht implementieren.

## Verbindliche Governance

- Ausschließlich kostenlose Modelle und Dienste.
- Kein Paid-Fallback.
- Keine Fake-Erfolge.
- Keine Mock-Daten im Produktivbetrieb.
- Keine echten Secrets in Logs, Frontend, Git oder Dokumentation.
- Fehlende Credentials dürfen lokal mögliche Arbeiten nicht blockieren.
- Keine automatische Veröffentlichung ohne menschliche Freigabe.
- Controller und Supervisor bleiben gestoppt.
- STOP-Flag bleibt gesetzt.
- Keine konkurrierenden Coding-Prozesse während der finalen Abnahme.
- Kein Commit, Push, PR, Merge, Deployment, Controller-Neustart oder tatsächliches Publishing ohne separate ausdrückliche Freigabe.

## Autonome Arbeitsweise

- Arbeite H.0 bis H.8 eigenständig und vollständig ab.
- Prüfe vor jeder Implementierung, ob die Funktion bereits existiert.
- Aktualisiere die persistente Aufgabenliste nach jedem Arbeitspaket.
- Bei Unterbrechungen, Modelllimits oder Free-Quota-Limits den Arbeitsfortschritt dauerhaft dokumentieren.
- Beim nächsten autorisierten Lauf exakt an der letzten offenen Aufgabe fortsetzen.
- Keine bereits abgeschlossenen Arbeitspakete unnötig wiederholen.
- Externe Blocker separat dokumentieren und mit allen unabhängigen lokalen Aufgaben fortfahren.

## Abschlussbericht

Melde: Gesamtfortschritt lokal und GitHub, Status jedes Arbeitspakets H.0–H.8, Anzahl implementierter Funktionen, Anzahl bestandener Tests und Testdateien, Ergebnisse beider isolierter QA-Läufe, Browser- und Frontendabnahme, Security-Findings, tatsächlichen Git-Status, externe Blocker, verbleibende Aufgaben, geschätzte Restzeit, Vorbereitung von Phase I.

Finaler Status: READY_FOR_COMMIT oder NOT_READY_FOR_COMMIT.

Warte anschließend auf meine ausdrückliche Freigabe für Commit und GitHub-Synchronisierung.
