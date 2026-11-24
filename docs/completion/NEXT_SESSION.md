# NEXT SESSION

## Einstieg

- Repo: `/home/kaishinglo/ugc-affiliate-creator-clipping-os`
- Branch: `main`, HEAD `ef0e4347bd344389866f10ba7623eff33d1a56de`
- Lokale Änderungen (nicht committen): `docs/autonomous-build/STATE.md`, `package-lock.json`, plus diese Sitzung
- Node 22.23.5, npm 10.9.9, Debian 13, 2 CPUs, 4 GB RAM

## Startbefehle

UGC:
```bash
cd /home/kaishinglo/ugc-affiliate-creator-clipping-os
npm run dev
```

Browser-Runtime-Host:
```bash
cd /home/kaishinglo/ugc-affiliate-creator-clipping-os/browser-runtime-host
BROWSER_RUNTIME_TOKEN="$(sed -n 's/^BROWSER_RUNTIME_TOKEN=//p' ../.env)" \
BROWSER_RUNTIME_PORT="$(sed -n 's/^BROWSER_RUNTIME_PORT=//p' ../.env)" \
BROWSER_RUNTIME_HOST="$(sed -n 's/^BROWSER_RUNTIME_HOST=//p' ../.env)" \
node server.mjs
```

## Nächste sinnvolle Aufgaben

1. Integrationsstatus ehrlich machen (`src/integrations.ts`, `src/index.ts:254-272`) — CONFIGURED nur bei echtem Adapter
2. Deterministische Agentenoutputs ohne Fake-Freigaben (`src/orchestration.ts:199-207`)
3. Isolierte Test-DB einrichten und Gesamtsuite (122 Tests) reproduzieren
4. Extern blockiert: `OLLAMA_API_KEY`, `DISCOVERY_MCP_CLIENT`, `MECE_DASHBOARD_TOKEN`