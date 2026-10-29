# UGC Affiliate Creator Clipping OS

Eigenständige Anwendung (keine CarryOS-Abhängigkeit) für UGC-, Affiliate- und Clipping-Workflows: von der Produktidee über Skript und Video bis zu Veröffentlichung und Auswertung – mit menschlicher Freigabe und Audit-Log.

## Architektur

```text
Web UI -> Application API
  -> Authentifizierung und Autorisierung
  -> Product / Creator / Campaign / Content Domains
  -> Workflow Engine + Job Queue
  -> Agent Runtime -> AI Gateway -> Provider-Adapter
  -> Human Approval Service + Audit/Event Log
  -> Video Worker
  -> Affiliate-, Research-, Publishing- und Analytics-Adapter
Datenbank + Object Storage + Secret Manager
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Stack

- Node 22+ / TypeScript
- Fastify
- PostgreSQL
- Vitest

## Schnellstart

```bash
git clone https://github.com/kaishinglo-create/ugc-affiliate-creator-clipping-os.git
cd ugc-affiliate-creator-clipping-os
cp .env.example .env   # Werte anpassen
npm install
npm run dev
```

## Konfiguration

Umgebungsvariablen (siehe `.env.example`):

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | PostgreSQL-Verbindung (erforderlich) |
| `SESSION_JWT_SECRET` | JWT-Secret, mind. 32 Zeichen (in Produktion erforderlich) |
| `APP_ENV` | `development` oder `production` |
| `CORS_ORIGIN` | Erlaubter Origin der Web-UI |
| `PORT` | HTTP-Port (Standard 3000) |

Secrets niemals committen.

## Scripts

- `npm run dev` - Dev-Server
- `npm run build` - Kompilieren
- `npm run typecheck` - Typprüfung
- `npm test` - Tests
- `npm run lint` - Lint (noch nicht konfiguriert)

## Dokumentation

- [docs/](docs/) – Phasen-Dokumentation (Baseline, Security Review, Test Reports)
- [AGENTS.md](AGENTS.md) – Hinweise für KI-Agenten
- [MASTER_PROMPT.md](MASTER_PROMPT.md) – Projekt-Masterprompt

## Grundsätze

- Affiliate-Links und Werbung werden gekennzeichnet
- Veröffentlichungen laufen über menschliche Freigabe
- Keine erfundenen Bewertungen oder irreführenden Aussagen
- Plattform- und Partnerprogramm-Richtlinien werden eingehalten

## Lizenz

Siehe [LICENSE](LICENSE).
