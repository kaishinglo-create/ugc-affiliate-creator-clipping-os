# API Anything discovery pilot

This standalone MCP server is the first provider for the API Integration
Department. Its only operation is a public YouTube video search. It runs over
stdio and returns up to 20 normalized, deduplicated candidates. Duplicates are
removed within a response. The pilot does not persist candidates or schedule
searches.

## Run

Use Node.js 22.23.4 or later.

```sh
cd pilots/api-anything
npm ci --ignore-scripts
npm run smoke -- 'creator video clipping workflow'
```

The smoke client verifies that the server exposes exactly one tool, then
requires at least one valid Tier 1 result. A network or provider failure
exits nonzero. A successful response with no candidates is valid for callers
of the server, but does not pass the live smoke check.

To connect another MCP client, use `node /absolute/path/to/pilots/api-anything/server.mjs`
as its stdio command and call `youtube_search` with `{"query":"your search"}`.

## Scope

API Anything is pinned in the pilot lockfile. The stock MCP tool does not
accept a tier cap in this version, so the pilot calls the installed-operation
host API behind its own MCP tool. It uses a fresh local data directory per
process, disables the shared catalog and caps execution at Tier 1. Its fetch
policy permits public GET requests to the YouTube search endpoint only,
including redirect hops. It does not need browser setup or a signed-in session.

The smoke test needs outbound HTTPS to YouTube and is run manually. Use it on
the Oracle VPS before enabling any scheduled calls. Queue integration,
workspace budgets and database deduplication belong in the UGC worker
integration, after the target environment has passed the smoke test.
