# API Anything discovery pilot

This standalone MCP server is the first provider for the API Integration
Department. Its only operation is a public YouTube video search. It runs over
stdio and returns up to 20 normalized, deduplicated candidates. Duplicates are
removed within a response. The standalone process returns its result to the caller. The UGC worker can
queue individual searches and persist their results.

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

The smoke test needs outbound HTTPS to YouTube and is run manually. Run it
on your target machine before enabling the worker integration.

## Connect to the UGC worker

Set `DISCOVERY_MCP_CLIENT` to the absolute path to this directory's
`smoke.mjs` in the UGC server environment and run the engine. Use
`POST /api/discovery/searches` as a workspace owner or admin with
`{"query":"creator video clipping workflow"}`. An optional ISO 8601 `runAt`
schedules a single run. The response contains the queued job. Use
`GET /api/jobs/:id` for the result status and `GET /api/discovery/candidates`
for the latest saved candidates. Both use the existing workspace session.

The worker limits search attempts to ten per workspace per UTC day.
Identical queries deduplicate within the requested scheduling hour.
Candidate IDs deduplicate across all runs within the workspace.
## Recurring search

An owner or admin can save one schedule per workspace using
`PUT /api/discovery/schedule`, for example
`{"query":"creator video clipping workflow","intervalMinutes":180,"enabled":true}`.
Use `GET /api/discovery/schedule` to check the next due time. The minimum
interval is three hours and the maximum is seven days. Saving an enabled
schedule makes the next search due on the next engine tick. The worker
resumes with one search after downtime. Set `enabled` to false to stop
scheduling new searches. Already queued jobs can be managed separately.
Scheduled and manual runs share the same daily workspace budget.
