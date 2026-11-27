# Phase H — Vorbereitung (2026-11-27)

Status: **prepared, not started**. Es wurde kein Phase-H-Code geschrieben, kein
Service gestartet und keine Freigabe eingeholt. Dieses Dokument legt nur den
Rahmen fest, damit Phase H nach einer expliziten Entscheidung begonnen werden
kann.

## Ziel

Live Publishing und Affiliate-Tracking auf Basis der bereits vorhandenen,
ehrlichen Infrastruktur:

- `src/publishing.ts` + `/api/publishing/*`: Queue, Retry, Idempotenz, Audit und
  manuelle Freigabe. Ohne Credentials `NOT_CONFIGURED` (503), mit Credentials
  `CREDENTIALS_ONLY` + `ADAPTER_NOT_IMPLEMENTED` (501).
- `src/affiliate.ts` + `/api/affiliate/*`: gespeicherte Klicks/Conversions,
  Attribution, Payout-Statusmaschine. Keine Geldbewegung, kein externes Netzwerk.
- `src/api-integration-center/*`: 14 Provider mit echten Probes, verschlüsselten
  Credentials und `CONNECTED` erst nach erfolgreichem echten Aufruf.

## Voraussetzungen (extern, derzeit blockiert)

- Echte Plattform-Credentials und OAuth-App-Freigaben für YouTube/TikTok/Meta.
- `API_INTEGRATIONS_OAUTH_BASE_URL` mit öffentlicher HTTPS-URL (Produktion).
- `API_INTEGRATIONS_MASTER_KEY` bzw. `..._FILE` aus sicherer Quelle.
- `YOUTUBE_API_KEY` bzw. Discovery-MCP-Provider für echte Quellen.
- Deployment-Credentials und ausdrückliche Freigabe für Push/PR/Merge/Deploy.

Ohne diese Voraussetzungen bleibt jeder Status ehrlich `NOT_CONFIGURED`,
`CREDENTIALS_ONLY` oder `ADAPTER_NOT_IMPLEMENTED`. Es gibt keinen Paid-Fallback,
keinen simulierten Upload und keine erfundenen Kennzahlen.

## Geplante Akzeptanzkriterien (noch nicht geprüft)

1. **Echte Adapter**: pro Provider
   `CONNECTED` nur nach erfolgreichem, redactetem Provider-Call mit auditiertem
   Zeitstempel; kein Adapter-Stub wird als live ausgegeben.
2. **Freigabe-Kette**: Quality-Report bestanden + manuelle Approval + explizite
   Operator-Aktion vor jedem Upload; kein auto-publish.
3. **Idempotenz/Retry**: Queue, `idempotencyKey`, Retry-Grenzen und Audit-Events
   bleiben wirksam; kein Doppel-Upload bei erneutem Verarbeiten.
4. **Attribution/Payout**: nur gespeicherte Workspace-Zeilen; Revenue/Conversion
   nie erfunden; Payout-Übergänge nur `pending → approved → paid` mit Audit.
5. **RLS/Redaction**: alle neuen Schreibpfade laufen über
   `withWorkspaceTransaction`; keine Secrets in API, Logs, Audit oder Doku.
6. **Verifikation**: Typecheck/ESLint/Build, vollständige Suite, zwei isolierte
   `qa:full`-Läufe, Playwright, echter Medienlauf, Security-Audit.

## Explizit nicht Teil der Vorbereitung

- Kein Code, keine Migration, kein Adapter, kein Credential, kein Deploy.
- Kein automatisches Veröffentlichen und kein Umgehen von Login/MFA/CAPTCHA.
- Kein Start des autonomen Controllers ohne neue, ausdrückliche Freigabe.

Nachweis: `PHASE_G_FINAL_ACCEPTANCE_REPORT.md` Abschnitt 8; Roadmap
`MASTER_ROADMAP.md` / `MASTER_ROADMAP.json` (`nextPhaseStatus:
prepared_not_started`).
