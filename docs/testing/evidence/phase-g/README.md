# Phase G — kuratierte QA-Nachweise

Dieses Verzeichnis enthält bewusst **kuratierte** Nachweise aus der finalen
Phase-G-Abnahme vom 2026-11-27. Es enthält keine Secrets, keine echten
personenbezogenen Daten, keine Datenbankzugänge, keine rohen Runtime-Logs und
keine Medien-Binaries.

Die reproduzierbaren Skripte liegen unter `scripts/phase-g-mece-browsercheck.mjs`
und `scripts/phase-g-frontend-acceptance.mjs` und sind über
`npm run verify:mece-browser` bzw. `npm run verify:frontend` aufrufbar. Sie
schreiben ihre Rohergebnisse standardmäßig in ein temporäres Verzeichnis;
`PHASE_G_EVIDENCE_DIR` überschreibt das Ziel.

Der geprüfte Quellcodestand entspricht `fd9a356`. Nach den beiden `qa:full`-Läufen
wurden nur die E2E-Timing-Fixes in `tests/e2e/*.spec.ts` vorgenommen (Vitest
schließt `.spec.ts` nicht ein); diese sind in `fd9a356` enthalten. Danach kamen
nur Dokumentation, die beiden reproduzierbaren Prüfskripte und diese Nachweise
hinzu.

| Datei | Inhalt |
|---|---|
| `qa-full.json` | Zusammenfassung der zwei isolierten QA-Läufe (327 Tests / 81 Dateien je Lauf) |
| `playwright.json` | Ergebnis der 9 Playwright-E2E-Tests |
| `mece-browsercheck.json` | Ergebnis des reproduzierbaren 27-Punkt-MeCE-Browserchecks |
| `frontend-acceptance.json` | Ergebnis der 19-Punkt-Frontendabnahme aller 15 Tabs |
| `real-media.json` | Kuratierte Zusammenfassung der echten Medienpipeline |

Externe Live-Verifikation bleibt ausdrücklich **ausstehend**: kein
`YOUTUBE_API_KEY`, kein Discovery-MCP-Provider, kein `OLLAMA_API_KEY`, keine
Plattform- oder Deployment-Credentials und kein öffentlicher Host für einen
echten URL-Download. Keine der Dateien hier behauptet einen externen Live-Erfolg.
