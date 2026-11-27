# Phase G Baseline Audit (G.0)

Branch: `feature/phase-g-live-discovery-clipping`
Baseline HEAD: `17c6dcc27c6a8c63fdfdd6719f4a272543bc1c23`

## MECE Feature Matrix

Legend: Implemented / Partial / Not implemented; Tested / Live-verified / Externally blocked; Risks / Dependencies.

| Area | Capability | Status | Tested | Live-verified | External blockers | Security risks | Dependencies |
|---|---|---|---|---|---|---|---|
| Discovery | YouTube search worker | Partial | Yes (fakes) | No | No MCP provider / YouTube access | Provider-supplied cursor trusted; no YouTube API auth | `DISCOVERY_MCP_SERVER/CLIENT` |
| Discovery | API Anything MCP pilot | Partial (code) | Yes | No | Tier-1 only, no Tier-2 | ToS-sensitive scraping | `pilots/api-anything` deps |
| Discovery | Browser-based discovery | Not implemented | No | No | Browser runtime available but unwired | SSRF already hardened in `browser-gateway.ts` | Browser runtime host |
| Discovery | Creator / keyword / trend discovery | Not implemented | No | No | YouTube API key | – | YouTube Data API |
| Discovery | Recurring schedules | Implemented (code) | Yes | No | No live provider | – | Engine tick |
| Discovery | Cursor processing | Partial | Yes | No | Pilot cursor is a no-op; scheduled jobs omit cursor | – | `OperationalPolicy` |
| Discovery | Dedup / RLS / quotas / retry | Partial/Implemented | Yes | No | – | – | Prisma, FORCE RLS |
| Research | Multi-dimensional content scoring | Partial (one score) | Yes | No | No live AI key | – | `src/scoring.ts` |
| Media | Upload / validation / ffprobe | Partial | Yes | No | – | Fastify bodyLimit 1MiB caps configured uploads; symlink/range risk | ffmpeg/ffprobe |
| Media | Rights / license / checksum / lifecycle | Not implemented | No | No | – | Unauthorized media processing possible | – |
| Clipping | Extract audio / transcribe / highlight | Implemented | Yes | Yes (`verify:media`) | – | – | ffmpeg, whisper.cpp |
| Clipping | Scene detection / ML segment scoring | Not implemented | No | No | – | – | – |
| Clipping | Rendering / job progress | Partial | Yes | Partial | Media jobs not auto-processed by engine | – | ffmpeg |
| Production | Aspect ratios / SRT / burn-in | Partial | Yes | Yes (720x1280) | – | Safe ffmpeg args | ffmpeg |
| Production | VTT / thumbnails / brand templates / copy | Not implemented | No | No | – | – | – |
| Quality | Generic approval center | Partial | Yes | No | – | – | `src/index.ts` |
| Quality | Per-clip quality reports | Not implemented | No | No | – | – | – |
| Agents | Multi-agent departments | Implemented | Yes | No | – | – | `src/orchestration.ts` |
| Frontend | Discovery/media/clip controls | Partial | Yes | No | – | – | `public/app.js` |
| QA | Full suite / qa:full / CI | Implemented | Yes | CI green | – | – | QA runtime |

## Key gaps for Phase G

- Browser-based, creator, keyword and trend discovery not wired.
- YouTube Data API integration absent; no live provider configured.
- Research scoring covers only one generic score; 9 required dimensions absent.
- Media rights/license metadata, checksums and storage lifecycle absent.
- Scene detection and automatic clip-candidate ranking absent.
- VTT, thumbnails, brand templates, hook/title/description/hashtag generation absent.
- Persistent per-clip quality reports and media-specific approval gates absent.

## Live verification status

- Only `scripts/verify-media-runtime.ts` provides real live media verification (real ffmpeg/whisper, generated clips, SSIM proof).
- Discovery tests are controlled doubles; no live YouTube/MCP data.
- No platform publishing credentials; publishing remains gated.
