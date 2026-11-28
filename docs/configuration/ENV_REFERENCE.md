# ENV_REFERENCE — vollständige Umgebungskonfiguration

Stand: generiert aus dem aktuellen Quellcode und dem lokalen `.env`. **Es werden keine echten Werte ausgegeben.**

## Methode

Gescannt wurden `src/`, `lib/`, `scripts/`, `public/`, `prisma/`, `browser-runtime-host/`, `.mece-control/`, `pilots/api-anything/`, `tests/`, `package.json` und `.env.example`.
Ausgeschlossen: `node_modules/`, `src/generated/`, `dist/`, Build-Artefakte, Logs und JSONL-Historien.
`process.env`, `import.meta.env`, `env`-Parameter, Dotenv-Ladung, Shell-`${VAR:-...}`-Overrides und Prisma-/Tooling-Env wurden berücksichtigt.

Status bezieht sich ausschließlich auf die lokale `.env`; Prozessumgebung kann Werte zur Laufzeit überschreiben.
Legende: `SET` = gesetzt und plausibel, `EMPTY` = leer, `MISSING` = nicht vorhanden, `INVALID` = gesetzt aber ungültig.

Kurzfassung: SET 30 · MISSING 65 · EMPTY 2

## Kern & Datenbank

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | PostgreSQL-Verbindungsstring | pflicht | — | URL/String | Prisma-Pg-Adapter, CLI-Migrationen und Services Doctor | lib/db.ts:8; src/config.ts:27; scripts/services.sh:313 | lokal | ja | SET | App startet nicht; DB-/RLS-Prüfungen nicht möglich |
| `SESSION_JWT_SECRET` | HMAC-Schlüssel für Session-Cookies | pflicht | — | String >= 32 Zeichen | Signatur/Verifikation der Sessions | src/config.ts:28; lib/auth.ts:11 | lokal generierbar | ja | SET | App startet hart; kein statischer Dev-Fallback |

## Auth & HTTP

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `APP_ENV` | Laufzeitumgebung | optional | development | development\|production | Cookie-Secure-Flag und Config-Modus | src/config.ts:25; lib/auth.ts:66 | lokal | ja | SET | production-spezifische Cookie-Härtung entfällt |
| `NODE_ENV` | Node-/Tooling-Umgebung | optional | — | String | Fallback für APP_ENV, Prisma-Logging | src/config.ts:25; lib/db.ts:12; lib/auth.ts:66 | lokal | ja | MISSING | Fallback auf APP_ENV bzw. development |
| `CORS_ORIGIN` | Erlaubte Browser-Origin | optional | http://localhost:5173 | URL/String | Fastify-CORS-Freigabe | src/config.ts:41 | lokal | ja | SET | Browser-UI kann API nicht erreichen |
| `PORT` | HTTP-Port der App | optional | 3000 | Zahl | Fastify-Listen-Port; Fallback des Browser-Hosts | src/config.ts:42; browser-runtime-host/server.mjs:5 | lokal | ja | SET | Default-Port 3000 wird verwendet |
| `TRUST_PROXY` | Proxy-Vertrauensmodus | optional | false | false\|0\|loopback\|Zahl\|true\|1 | Fastify trustProxy | src/index.ts:19; src/config.ts:16-21 | lokal | ja | SET | Fail-closed: keine Proxy-Header-Vertrauensstellung |

## KI & Provider

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `OLLAMA_API_KEY` | Ollama-Cloud-API-Key | optional | — | Secret/String | Ollama-Cloud-Chat und AI-Gateway | src/ai/provider.ts:54; src/ollama.ts:14 | extern | nicht garantiert | EMPTY | Ollama/AI wird als nicht konfiguriert markiert |
| `OLLAMA_BASE_URL` | Ollama-Cloud-Endpunkt | optional | https://ollama.com | URL | AI-Provider-Requests | src/ai/provider.ts:55 | lokal/extern | ja | SET | Default-Endpunkt wird verwendet |
| `OLLAMA_MODEL` | Standardmodell für Agenten und Ollama | optional | Base 1-flash | String | Modellauflösung und Audit-Metadaten | src/ai/models.ts:11; src/ollama.ts:19; src/index.ts:2608,2626,2641 | lokal | ja | SET | Repo-Default wird verwendet |
| `OLLAMA_MODEL_<AGENT>` | Agentenspezifische Modellübersteuerung | optional | — | String (Muster) | resolveAgentModel pro Agent | src/ai/models.ts:9 | lokal | ja | MISSING | OLLAMA_MODEL bzw. Default gilt |
| `AGENT_AI_MODE` | AI-Verhalten der Agenten | optional | auto | auto\|off\|required | Gateway-Modus | src/ai/gateway.ts:16 | lokal | ja | SET | auto: deterministische Ausgabe ohne AI |
| `AI_MAX_DAILY_REQUESTS_PER_WORKSPACE` | Tageslimit AI-Requests je Workspace | optional | 100 | Zahl (0 = aus) | AI-Gateway-Budget | src/ai/gateway.ts:22 | lokal | ja | SET | Fallback auf OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE, dann 100 |
| `OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE` | Tageslimit Ollama-Requests je Workspace | optional | 100 | Zahl (0 = aus) | Ollama-Budget und -Audit | src/index.ts:2584; src/ai/gateway.ts:22 | lokal | ja | SET | Default 100; 0 deaktiviert Ollama |

## Automatisierung

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `AUTOMATION_ENGINE` | Hintergrund-Job-Engine | optional | on | on\|off | Job-Claim/Loop | src/engine.ts:500; src/index.ts:2682 | lokal | ja | SET | off = API-only-Prozess |
| `AUTOMATION_ENGINE_INTERVAL_MS` | Poll-Intervall der Engine | optional | 3000 | Zahl 250..300000 | Engine-Takt | src/engine.ts:503,517 | lokal | ja | SET | Default 3000 ms |
| `OPENCODE_BIN` | Pfad zur OpenCode-CLI | optional | opencode | Pfad/String | Autonomer Controller | scripts/autonomous-controller.mjs:533 | lokal | ja | SET | PATH wird verwendet |

## MECE & Controller

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `MECE_DASHBOARD_TOKEN` | Operator-Token des Control Centers | pflicht für MECE | — | String >= 32 Zeichen | Dashboard-Auth in API, MECE und Doctor | src/index.ts:690; .mece-control/server.mjs:30; scripts/services.sh:303 | lokal generierbar | ja | SET | MECE-Bridge/UI fail-closed 401 |
| `MECE_CONTROL_PORT` | Port des MECE-Control-Servers | optional | 3031 | Zahl | MECE-HTTP-Server | .mece-control/server.mjs:22 | lokal | ja | SET | Default 3031 |
| `MECE_OPENCODE_PORT` | Port des von MECE gestarteten OpenCode-Servers | optional | 4096 | Zahl | MECE/OpenCode-Child-Prozess | .mece-control/server.mjs:23 | lokal | ja | SET | Default 4096; fremde Ports nicht freiräumen |
| `OPENCODE_PORT` | Legacy-Alias für MECE_OPENCODE_PORT | optional | — | Zahl | Fallback-Port | .mece-control/server.mjs:23 | veraltet | ja | MISSING | Nur wirksam ohne MECE_OPENCODE_PORT |
| `OPENCODE_SERVER_PASSWORD` | Basic-Auth-Passwort des OpenCode-Servers | optional | ephemer generiert | Secret/String | MECE-Child-Env | .mece-control/server.mjs:494,542 | lokal generierbar | ja | MISSING | MECE erzeugt ein temporäres Passwort |
| `OPENCODE_PASSWORD` | Legacy-Alias des OpenCode-Passworts | optional | — | Secret/String | Fallback für Basic Auth | .mece-control/server.mjs:494 | veraltet | ja | MISSING | Nur wirksam ohne OPENCODE_SERVER_PASSWORD |
| `CONTROLLER_STATUS_FILE` | Pfad-Override für den Controller-Status | optional | — | Pfad | Watchdog und Doctor | scripts/controller-watchdog.sh:50,233; scripts/services.sh:175 | diagnostisch | ja | MISSING | Standardpfad .mece-control/state.json |
| `CONTROLLER_AGENT_TIMEOUT_MS` | Timeout eines Controller-Agentenlaufs | optional | 480000 | Zahl ms | Autonomer Controller | scripts/autonomous-controller.mjs:51 | lokal | ja | MISSING | Default 480000 ms |
| `CONTROLLER_FULL_TEST_TIMEOUT_MS` | Timeout des Full-Test-Laufs | optional | 480000 | Zahl ms | Autonomer Controller | scripts/autonomous-controller.mjs:54 | lokal | ja | MISSING | Default 480000 ms |
| `WATCHDOG_MIN_FREE_MEMORY_MB` | Mindestfreier RAM in MB | optional | 256 | Zahl | Watchdog-Ressourcengate | scripts/controller-watchdog.sh:105 | lokal | ja | MISSING | Default 256 MB |
| `WATCHDOG_MIN_CGROUP_MEMORY_MB` | Mindestfreier Cgroup-RAM in MB | optional | 256 | Zahl | Watchdog-Ressourcengate | scripts/controller-watchdog.sh:106 | lokal | ja | MISSING | Default 256 MB |
| `WATCHDOG_MIN_DISK_GB` | Mindestfreier Diskplatz in GB | optional | 1 | Zahl | Watchdog-Ressourcengate | scripts/controller-watchdog.sh:107 | lokal | ja | MISSING | Default 1 GB |
| `WATCHDOG_MAX_LOAD_MULTIPLIER` | Maximaler Load-Faktor je CPU | optional | 2 | Zahl | Watchdog-Ressourcengate | scripts/controller-watchdog.sh:108 | lokal | ja | MISSING | Default 2x CPU-Anzahl |
| `WATCHDOG_HEARTBEAT_MIN_AGE_SECONDS` | Mindestalter des Heartbeats | optional | 60 | Zahl s | Watchdog-Entscheidung | scripts/controller-watchdog.sh:161-162 | lokal | ja | MISSING | Default 60 s |
| `WATCHDOG_JOURNAL_BEFORE` | Interner Journal-Offset | optional | 0 | Zahl | Watchdog-Nachlauf | scripts/controller-watchdog.sh:224 | intern | ja | MISSING | 0 wird angenommen |
| `WATCHDOG_ONCE_TIMEOUT_SECONDS` | Timeout eines --once-Laufs | optional | 900 | Zahl s | Watchdog-Ausführung | scripts/controller-watchdog.sh:205 | lokal | ja | MISSING | Default 900 s |
| `WATCHDOG_SCHEDULE_INTERVAL_SECONDS` | Intervall des Scheduler-Loops | optional | 300 | Zahl s | Watchdog-Scheduler | scripts/controller-watchdog-scheduler.sh:14 | lokal | ja | MISSING | Default 300 s |
| `WATCHDOG_SCHEDULE_TICKS` | Anzahl Ticks pro Scheduler-Lauf | optional | 1 | Zahl | Watchdog-Scheduler | scripts/controller-watchdog-scheduler.sh:15 | lokal | ja | MISSING | Default 1; stoppt nach gebundener Ausführung |
| `WATCHDOG_SCHEDULE_LOG_FILE` | JSONL-Log des Schedulers | optional | .run/controller-watchdog-schedule.jsonl | Pfad | Watchdog-Scheduler | scripts/controller-watchdog-scheduler.sh:16 | lokal | ja | MISSING | Defaultpfad wird verwendet |
| `WATCHDOG_SCRIPT` | Pfad zum Watchdog-Skript | optional | scripts/controller-watchdog.sh | Pfad | Scheduler-Override | scripts/controller-watchdog-scheduler.sh:13 | diagnostisch | ja | MISSING | Defaultpfad wird verwendet |
| `WATCHDOG_RUNNER` | Interpreter für das Watchdog-Skript | optional | bash | String | Scheduler-Override | scripts/controller-watchdog-scheduler.sh:12 | diagnostisch | ja | MISSING | Default bash |
| `NODE_BIN` | Node-Binary-Override | optional | node | Pfad | Watchdog/Scheduler/Doctor | scripts/controller-watchdog.sh:10; scripts/controller-watchdog-scheduler.sh:11 | diagnostisch | ja | MISSING | PATH wird verwendet |
| `TMPDIR` | Temporäres Wurzelverzeichnis | optional | /tmp/opencode (Skripte) | Pfad | Watchdog/Scheduler/Pilot | scripts/controller-watchdog.sh:13; scripts/controller-watchdog-scheduler.sh:31 | lokal | ja | MISSING | OS-Default bzw. /tmp/opencode |
| `WATCHDOG_SCHEDULE_*` | Interne Scheduler-Protokollfelder | intern | — | String/Zahl | JSONL-Protokoll des Schedulers | scripts/controller-watchdog-scheduler.sh:76-95 | intern | ja | MISSING | Keine Auswirkung ohne Scheduler |
| `MECE_TEST_CONTROL_PORT` | Test-Override des MECE-Ports | optional | 3131 | Zahl | MECE-Runtime-Test | tests/mece-runtime.test.ts:6 | test-only | ja | MISSING | Default 3131 im Test |
| `MECE_TEST_OPENCODE_PORT` | Test-Override des OpenCode-Ports | optional | 4097 | Zahl | MECE-Runtime-Test | tests/mece-runtime.test.ts:7 | test-only | ja | MISSING | Default 4097 im Test |

## Discovery & MCP

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `DISCOVERY_MCP_SERVER` | Absoluter Pfad zum MCP-Server (stdio) | optional | — | absoluter Pfad | YouTube-Creator-/Produkt-Discovery | src/discovery.ts:80 | lokal | ja | MISSING | Discovery bleibt deaktiviert |
| `DISCOVERY_MCP_CLIENT` | Legacy-One-Shot-Client-Pfad | optional | — | absoluter Pfad | Discovery-Fallback | src/discovery.ts:86 | veraltet | ja | EMPTY | Nur wirksam ohne SERVER |
| `HTTP_PROXY` | Proxy für ausgehende Discovery-Calls | optional | — | URL | MCP-Kindprozess/netzwerk | src/discovery.ts:75-76; pilots/api-anything/smoke.mjs:6 | lokal | ja | MISSING | Direkte Verbindung |
| `HTTPS_PROXY` | HTTPS-Proxy für Discovery | optional | — | URL | MCP-Kindprozess/netzwerk | src/discovery.ts:75-76; pilots/api-anything/smoke.mjs:6 | lokal | ja | MISSING | Direkte Verbindung |
| `NO_PROXY` | Proxy-Ausnahmen | optional | — | String | MCP-Kindprozess/netzwerk | src/discovery.ts:75-76; pilots/api-anything/smoke.mjs:6 | lokal | ja | MISSING | Keine Ausnahmen |
| `NODE_USE_ENV_PROXY` | Node-Proxy-Schalter | optional | — | String | MCP-Kindprozess | src/discovery.ts:75-76; pilots/api-anything/smoke.mjs:6 | lokal | ja | MISSING | Node-Default |
| `NODE_EXTRA_CA_CERTS` | Zusätzliche CA-Zertifikate | optional | — | Pfad | MCP-Kindprozess | src/discovery.ts:75-76; pilots/api-anything/smoke.mjs:6 | lokal | ja | MISSING | System-CA |
| `API_ANYTHING_HOME` | Temporäres Home des Pilot-Servers | intern | mkdtemp | Pfad | api-anything/host | pilots/api-anything/server.mjs:117 | intern | ja | MISSING | Pilot setzt Wert selbst |
| `API_ANYTHING_LOCAL_ONLY` | Lokaler Modus des Pilot-Servers | intern | 1 | 0\|1 | api-anything/host | pilots/api-anything/server.mjs:118 | intern | ja | MISSING | Externe Registry wäre aktiv |
| `API_ANYTHING_KEY` | Optionaler API-Anything-Schlüssel | optional | — | Secret/String | Externe API-Anything-Registry | nur Abhängigkeit api-anything/host (ausgeschlossen) | extern | nicht garantiert | MISSING | Lokaler Tier-1-Pilot bleibt nutzbar |
| `API_ANYTHING_TOKEN` | Optionales API-Anything-Token | optional | — | Secret/String | Externe Registry-Auth | nur Abhängigkeit api-anything/host (ausgeschlossen) | extern | nicht garantiert | MISSING | Lokaler Tier-1-Pilot bleibt nutzbar |
| `API_ANYTHING_REGISTRY` | Optionale externe Registry-URL | optional | — | URL | Externe Discovery-Quellen | nur Abhängigkeit api-anything/host (ausgeschlossen) | extern | nicht garantiert | MISSING | Lokaler Pilot bleibt nutzbar |

## Browser Runtime

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `BROWSER_RUNTIME_URL` | URL des Browser-Runtime-Hosts | optional | — | URL | HTTP-Browser-Adapter | src/browser-gateway.ts:331 | lokal | ja | SET | Lokaler Browser-Adapter entfällt |
| `BROWSER_RUNTIME_TOKEN` | Token für den Browser-Runtime-Host | optional | — | Secret/String | Auth des Browser-Adapters | src/browser-gateway.ts:336; browser-runtime-host/server.mjs:6 | lokal generierbar | ja | SET | Runtime-Anfragen werden abgelehnt |
| `BROWSER_RUNTIME_PORT` | Port des Browser-Runtime-Hosts | optional | 3200 | Zahl | Browser-Host | browser-runtime-host/server.mjs:5 | lokal | ja | SET | Default 3200 |
| `BROWSER_RUNTIME_HOST` | Bind-Adresse des Browser-Hosts | optional | 127.0.0.1 | Host | Browser-Host | browser-runtime-host/server.mjs:7 | lokal | ja | SET | Loopback-Bind |
| `BROWSER_EXECUTABLE_PATH` | Expliziter Chromium-Pfad | optional | — | Pfad | Playwright-Executable | browser-runtime-host/server.mjs:8 | lokal | ja | SET | Playwright-Standardpfad wird gesucht |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Legacy-Alias des Chromium-Pfads | optional | — | Pfad | Playwright-Fallback | browser-runtime-host/server.mjs:8 | veraltet | ja | MISSING | Nur ohne BROWSER_EXECUTABLE_PATH |

## Medien

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `FFMPEG_BIN` | ffmpeg-Binary-Pfad | optional | ffmpeg (PATH) | Pfad | Clipping/Audio-Extraktion | src/video/clipping.ts:182-184; scripts/services.sh:282 | lokal | ja | SET | Medienjobs scheitern mit NOT_CONFIGURED |
| `FFPROBE_BIN` | ffprobe-Binary-Pfad | optional | ffprobe (PATH) | Pfad | Medienanalyse | src/video/clipping.ts:182-184; scripts/services.sh:283 | lokal | ja | SET | Medienjobs scheitern mit NOT_CONFIGURED |
| `FFMPEG_VIDEO_CODEC` | H.264-Codec-Name | optional | libx264 | String | Video-Export | src/video/clipping.ts:175 | lokal | ja | MISSING | Default libx264 |
| `FFMPEG_TIMEOUT_MS` | Timeout pro ffmpeg/ffprobe-Aufruf | optional | 120000 | Zahl ms 1000..600000 | Binary-Sicherung | src/video/clipping.ts:204 | lokal | ja | MISSING | Default 120000 ms |
| `WHISPER_BIN` | whisper.cpp-Binary-Pfad | optional | whisper (PATH) | Pfad | Transkription | src/transcription.ts:192; scripts/services.sh:285 | lokal | ja | SET | NOT_CONFIGURED |
| `WHISPER_MODEL` | Pfad der englischen Standardgewichte | optional | — | Pfad | Transkription | src/transcription.ts:242; scripts/services.sh:291 | lokal | ja | SET | WHISPER_MODEL_NOT_CONFIGURED |
| `WHISPER_MODEL_MULTILINGUAL` | Pfad mehrsprachiger Gewichte (DE/auto) | optional | — | Pfad | DE-Transkription | src/transcription.ts:228,310 | lokal | ja | SET | DE-Sprache schlägt mit NOT_CONFIGURED fehl |
| `WHISPER_THREADS` | Threads pro Whisper-Lauf | optional | 1 | Zahl 1..cap | Ressourcenbegrenzung | src/transcription.ts:207 | lokal | ja | MISSING | Default 1 |
| `WHISPER_THREADS_MAX` | Obergrenze der Whisper-Threads | optional | 2 | Zahl 1..8 | Ressourcenbegrenzung | src/transcription.ts:203 | lokal | ja | MISSING | Default 2 |
| `WHISPER_TIMEOUT_MS` | Timeout pro Transkription | optional | 300000 | Zahl ms 1000..600000 | Binary-Sicherung | src/transcription.ts:197 | lokal | ja | MISSING | Default 300000 ms |
| `UGC_MEDIA_TMP_DIR` | Workspace-Scratch-Root | optional | OS-TMP | Pfad | Upload-/Job-Verzeichnisse | src/media-workspace.ts:19 | lokal | ja | MISSING | tmpdir() wird verwendet |
| `UGC_MEDIA_MAX_UPLOAD_BYTES` | Maximale Upload-Größe | optional | 8388608 | Zahl 1024..33554432 | Upload-Guard | src/media-workspace.ts:14 | lokal | ja | MISSING | Default 8 MiB |
| `MEDIA_VERIFY_DIR` | Ausgabeverzeichnis des Medien-Smoke-Tests | optional | /tmp/opencode/ugc-media-verify | Pfad | verify:media | scripts/verify-media-runtime.ts:17 | test-only | ja | MISSING | Defaultpfad wird verwendet |
| `WHISPER_SAMPLE` | Englisches Sprachsample für verify:media | optional | $HOME/.local/share/ugc-media/whisper/samples/en-test-sentence-cc0.wav | Pfad | verify:media | scripts/verify-media-runtime.ts:20 | test-only | ja | SET | Defaultpfad wird verwendet |
| `WHISPER_SAMPLE_DE` | Deutsches CC0-Sprachsample für verify:media | optional | $HOME/.local/share/ugc-media/whisper/samples/de-deutschland-cc0.flac | Pfad | verify:media (DE-Fall) | scripts/verify-media-runtime.ts:24 | test-only | ja | SET | DE-Fall wird als SKIPPED_EXTERNAL_SAMPLE markiert |
| `FFMPEG_ARGV_LOG` | Test-Double-Log für ffmpeg-Argumente | test-only | — | Pfad | Video-Pipeline-Tests | tests/video-pipeline.test.ts:80 | test-only | ja | MISSING | Keine Auswirkung im Betrieb |
| `FFPROBE_ARGV_LOG` | Test-Double-Log für ffprobe-Argumente | test-only | — | Pfad | Video-Pipeline-Tests | tests/video-pipeline.test.ts:81 | test-only | ja | MISSING | Keine Auswirkung im Betrieb |

## Publishing

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `PUBLISHING_LIVE_ADAPTERS` | Expliziter Opt-in für Live-Adapter | optional | 0 | 0\|1\|true | Publishing-Live-Gate | src/publishing.ts:101-105 | lokal | ja | SET | Kein Provider-HTTP-Call |
| `PUBLISHING_APPROVAL_TTL_HOURS` | Gültigkeit einer Publishing-Freigabe (1–720 h) | optional | 24 | Zahl | Approval-Ablauf | src/index.ts:1622 | lokal | ja | MISSING | 24 h Default |
| `PUBLISHING_MAX_DAILY_ATTEMPTS_PER_WORKSPACE` | Harter Tages-Cap für Publishing-Versuche | optional | 50 | Zahl | Budget-Gate | src/publishing.ts:1331 | lokal | ja | MISSING | 50 Versuche/Tag |
| `AFFILIATE_WEBHOOK_SECRET_<PROVIDER>` | HMAC-Secret für signierte Provider-Webhooks | optional webhook | — | Secret/String | Webhook-Signatur | src/index.ts:671 | extern | ja | MISSING | 503 WEBHOOK_NOT_CONFIGURED |
| `YOUTUBE_CLIENT_ID` | YouTube-OAuth-Client-ID | optional publishing | — | String | YouTube-Upload | src/publishing.ts:81 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `YOUTUBE_CLIENT_SECRET` | YouTube-OAuth-Client-Secret | optional publishing | — | Secret/String | YouTube-Token-Refresh | src/publishing.ts:81 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `YOUTUBE_REFRESH_TOKEN` | YouTube-Refresh-Token | optional publishing | — | Secret/String | YouTube-Token-Refresh | src/publishing.ts:81 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `TIKTOK_CLIENT_KEY` | TikTok-Client-Key | optional publishing | — | String | TikTok-Content-Posting | src/publishing.ts:88 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `TIKTOK_CLIENT_SECRET` | TikTok-Client-Secret | optional publishing | — | Secret/String | TikTok-Token-Refresh | src/publishing.ts:88 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `TIKTOK_REFRESH_TOKEN` | TikTok-Refresh-Token | optional publishing | — | Secret/String | TikTok-Token-Refresh | src/publishing.ts:88 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram-Long-Lived-Token | optional publishing | — | Secret/String | Instagram-Graph-Publishing | src/publishing.ts:95 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `INSTAGRAM_USER_ID` | Instagram-Business/Creator-User-ID | optional publishing | — | String | Media-Container | src/publishing.ts:95 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `INSTAGRAM_APP_ID` | Meta-App-ID | optional publishing | — | String | Token-Refresh | src/publishing.ts:95 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `INSTAGRAM_APP_SECRET` | Meta-App-Secret | optional publishing | — | Secret/String | Token-Refresh | src/publishing.ts:95 | extern | nicht garantiert | MISSING | NOT_CONFIGURED (503) |
| `YAPS_API_KEY` | Legacy-Integrationsschlüssel Yaps | optional | — | Secret/String | Nur Präsenzanzeige | src/integrations.ts:14 | extern | nicht garantiert | MISSING | Integration wird als nicht konfiguriert angezeigt |
| `CLIPPINGMINI_API_KEY` | Legacy-Integrationsschlüssel ClippingMini | optional | — | Secret/String | Nur Präsenzanzeige | src/integrations.ts:15 | extern | nicht garantiert | MISSING | Integration wird als nicht konfiguriert angezeigt |
| `KLAP_API_KEY` | Legacy-Integrationsschlüssel Klap | optional | — | Secret/String | Nur Präsenzanzeige | src/integrations.ts:16 | extern | nicht garantiert | MISSING | Integration wird als nicht konfiguriert angezeigt |
| `OPUSCLIP_API_KEY` | Legacy-Integrationsschlüssel OpusClip | optional | — | Secret/String | Nur Präsenzanzeige | src/integrations.ts:17 | extern | nicht garantiert | MISSING | Integration wird als nicht konfiguriert angezeigt |

## Diagnose & Verifikation

| Variable | Beschreibung | Pflicht | Default | Typ | Funktion | Datei:Zeile | Herkunft | Kostenlos | Status | Auswirkung bei Fehlen |
|---|---|---|---|---|---|---|---|---|---|---|
| `SERVICES_DOTENV_FILE` | Pfad der Doctor-.env-Datei | optional | .env | Pfad | Services Doctor | scripts/services.sh:120 | lokal | ja | MISSING | ROOT/.env wird gelesen |
| `SERVICES_DOCTOR_TIMEOUT_MS` | Timeout der Port-/HTTP-Probes | optional | 2000 | Zahl ms | Services Doctor | scripts/services.sh:99-101 | lokal | ja | MISSING | Default 2000 ms |
| `SERVICES_DOCTOR_PORTS` | Portchecks überspringen | optional | — | skip | Services Doctor | scripts/services.sh:188 | diagnostisch | ja | MISSING | Ports werden geprüft |
| `SERVICES_DOCTOR_DB_CHECK` | DB-Check überspringen | optional | — | 0 | Services Doctor | scripts/services.sh:316 | diagnostisch | ja | MISSING | DB wird geprüft |

## Externe Zugangsdaten, die du persönlich besorgen musst

| Anbieter | Offizielles Portal | Berechtigungen | Variablen | Hinweis |
|---|---|---|---|---|
| PostgreSQL (lokal) | [PostgreSQL / lokale Rolle](https://www.postgresql.org/docs/) | Nicht-Superuser-Rolle ugc_os_app mit RLS-Bypass deaktiviert | `DATABASE_URL` | Lokal kostenlos; keine externen Zugangsdaten nötig. |
| Google / YouTube | [Google Cloud Console](https://console.cloud.google.com/) | YouTube Data API v3 aktivieren; OAuth-Consent-Screen; Scope https://www.googleapis.com/auth/youtube.upload; Refresh-Token für Desktop-App | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` | Kostenlos innerhalb des API-Kontingents; Publishing benötigt zusätzlich PUBLISHING_LIVE_ADAPTERS=1. |
| TikTok | [TikTok Developers](https://developers.tiktok.com/) | Content Posting API v2, scope video.publish, App-Review und Creator-Autorisierung | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REFRESH_TOKEN` | Freigabe ist extern; ohne Freigabe bleibt Publishing ehrlich blockiert. |
| Instagram / Meta | [Meta Developers](https://developers.facebook.com/) | Instagram Graph API mit Business/Creator-Konto; pages_manage_metadata, instagram_content_publish (je nach App-Setup); Long-Lived Token | `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Basic Display API unterstützt kein Publishing. |
| Ollama Cloud | [Ollama](https://ollama.com/) | Account und API-Key; Modellzugriff gemäß Account | `OLLAMA_API_KEY` | Optional; 402 bei fehlendem Guthaben. Kein kostenpflichtiger Fallback. |
| OpenCode | [OpenCode](https://opencode.ai/) | CLI mit kostenlosen Modellen; kein API-Key erforderlich | — | Lokal kostenlos; aktuell über bestehende CLI-Anbindung nutzbar. |
| API Anything MCP | [lokaler Pilot / Paketdokumentation](https://www.npmjs.com/package/api-anything) | Lokaler Tier-1-Server benötigt keine externen Keys | `API_ANYTHING_KEY`, `API_ANYTHING_TOKEN`, `API_ANYTHING_REGISTRY` | Nur externe Registry-Optionen; aktuell nicht konfiguriert und nicht erfunden. |
| Legacy-Clipping-Integrationen | jeweiliger Anbieter | Provider-spezifisch; nur Präsenzanzeige im System | `YAPS_API_KEY`, `CLIPPINGMINI_API_KEY`, `KLAP_API_KEY`, `OPUSCLIP_API_KEY` | Nicht erforderlich; keine Live-Funktion in dieser Version. |

## Lokal und kostenlos nutzbar

- PostgreSQL mit Nicht-Superuser-Rolle `ugc_os_app`, RLS aktiv.
- OpenCode-CLI mit kostenlosen Modellen; kein API-Key nötig.
- MECE Control Center mit lokalem Dashboard-Token und konfigurierbaren Ports.
- Chromium/Playwright, FFmpeg/ffprobe und whisper.cpp lokal; keine Cloud-API nötig.
- Watchdog/Scheduler respektieren Cooldowns und starten ohne Freigabe keinen Modelllauf.
- Fehlende externe APIs führen zu ehrlichen `NOT_CONFIGURED`/`EMPTY`-Zuständen, nicht zum Abbruch des lokalen Betriebs.

## Bewusst ausgeschlossen

Abhängigkeitsinterne Variablen aus `node_modules` (u. a. `PLAYWRIGHT_*`, `PWTEST_*`, `BABEL_*`, `DOTENV_*`, CI-Anbieter-Variablen) sind keine Konfiguration dieser Anwendung und daher nicht Teil der Matrix.
Die Variablen `OPENCODE_PORT`, `OPENCODE_PASSWORD`, `DISCOVERY_MCP_CLIENT` und `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` sind Legacy-Aliase: dokumentiert, nicht gelöscht.
