# Phase I — Vorbereitung (2026-11-27)

Status: **prepared, not implemented**. Phase I wird nicht gestartet.

## Ausrichtung

Phase I bleibt unverändert auf **Self-Healing und Self-Improving** ausgerichtet
(vgl. `src/self-healing.ts`, `src/self-improving.ts` und die Phase-12-Artefakte).
Sie ist **nicht** ein Container für externe Live-Verifikation und nicht die
Fortsetzung von Phase H.

## Separater Blocker: externe Live-Verifikation

Externe Live-Verifikation ist ein **eigener, separater Blocker** und wird nicht
nach Phase I verschoben:

- Keine Plattform-Credentials / OAuth-App-Freigaben für YouTube, TikTok,
  Instagram → Publishing-Adapter bleiben `NOT_CONFIGURED` /
  `CREDENTIALS_ONLY` / `LIVE_VERIFICATION_PENDING`.
- Kein `YOUTUBE_API_KEY`, kein Discovery-MCP-Provider, kein `OLLAMA_API_KEY`.
- Kein öffentlicher Host für echte URL-Downloads, keine Deployment-Credentials.
- Keine echten Uploads, kein Paid-Fallback, kein Fake-Erfolg.

Diese Punkte bleiben in `docs/completion/EXTERNAL_BLOCKERS.txt` dokumentiert
und erfordern eigene Freigaben. Sie sind nicht Teil von Phase I.

## Vorbereitete Phase-I-Arbeitspakete (noch nicht implementiert)

1. Self-Healing: Incident-Vorschläge aus echten Audit-Zeilen, read-only, ohne
  automatische Policy-Anwendung.
2. Self-Improving: adviserbare Verbesserungen aus realen Audit-Events, ohne
   Modellkosten und ohne Fake-Erfolg.
3. Auswertung der in Phase H entstandenen Audit-Events (Publishing-Attempts,
   Approval-Widerrufe, Webhook-Rejections, Budget-Blockaden) als Eingabe für
   Self-Healing/Self-Improving.
4. Vier-Augen-Freigabe bleibt optional; der lokale Einzelbenutzerbetrieb nutzt
   weiterhin eine verbindliche menschliche Freigabe.

## Verbindliche Voraussetzungen

- Neue, ausdrückliche Freigabe für Phase I.
- Controller/Supervisor bleiben gestoppt, STOP-Flag bleibt gesetzt.
- Kein Commit/Push/PR/Merge/Deploy/Publishing ohne separate Freigabe.
- Fortsetzung exakt an der letzten offenen Aufgabe in `PHASE_H_TASKS.json`,
  sofern Phase H abgeschlossen ist.
