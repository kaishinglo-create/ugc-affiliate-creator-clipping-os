# Phase G Security Audit (2026-11-27)

Scope: `feature/phase-g-completion-2026-11-27` (commits `9f8efc9`, `b685a7b`).
Method: read-only source review plus targeted greps. No `.env` values were read
or reproduced. The dedicated security subagent was unavailable
(`Model unavailable: ollama-cloud/beam`), so this audit was performed manually.

## Findings

No Critical or High severity finding was identified in the new Phase G code.

### Medium — DNS rebinding residual risk (`src/media-download.ts`)

`assertPublicUrl` validates the literal URL, every resolved A/AAAA address and
every redirect target before fetching. A sophisticated attacker who controls DNS
could still answer with a public address during validation and a private address
during the actual connection (TOCTOU). Mitigation would require an HTTP agent
that pins the validated IP for the connection. This is a residual risk, not a
regression: the previous code performed no DNS validation at all and never
downloaded. Production effect is limited because URL sources require an operator,
`rights=AUTHORIZED`, a bounded size/timeout and an allowlisted content type.

### Low — `POST /api/discovery/score` persists on member request (`src/index.ts`)

`persist: true` writes a `ResearchReport` for any authenticated member of the
workspace (other media mutation routes require OWNER/ADMIN). The write is fully
workspace-scoped and contains no external side effect or secret. Classified as
Low; the operator-only convention would be stricter.

## Confirmed controls

- **Auth/roles:** all new mutating media, release and pipeline routes call
  `requireAuthWorkspace` and `requireOperatorRole`; read routes require
  `requireAuthWorkspace`. No unauthenticated path was added.
- **RLS / workspace isolation:** `src/research-reports.ts`,
  `src/media-download.ts`, `src/media-release.ts` and `src/phase-g-pipeline.ts`
  contain **no** direct global `prisma.*` access; every query runs through
  `withWorkspaceTransaction` (4/3/4/4 call sites respectively).
- **SSRF:** literal IPv4/IPv6, loopback, RFC1918, link-local, CGNAT, `.local`,
  `.localhost`, `.internal`, credentials-bearing URLs, non-http(s) schemes,
  private DNS answers and redirects to private addresses are rejected.
  Downloads are bounded by content type, 30 s timeout and the existing 8 MiB
  upload cap; oversize streams are cancelled.
- **Path safety:** `workspaceMediaPath` enforces basename-only names; VTT output
  names are revalidated after derivation; thumbnail/export outputs are confined
  to the workspace media root; `probeMedia`/`detectScenes` use `assertSafePath`.
- **Release gate:** `assertClipReleased` requires an existing `media_clip`
  approval in the same workspace, status exactly `approved`, and an `entityId`
  equal to the requested output name. Pending/rejected/mismatched approvals
  return 403/404/400 and no export runs.
- **Job fencing:** `PHASE_G_PIPELINE` re-checks workspace, lease id, lease owner,
  RUNNING status and lease expiry under `FOR UPDATE` before completion; heartbeat
  renews the lease; lost leases are skipped, never written.
- **Redaction:** new routes use `mediaErrorBody`/`mediaErrorStatus`, so absolute
  paths, captured stderr and environment values never reach clients. Audit data
  contains only basenames, counts and report/approval ids.
- **Honesty:** no mock data in production paths; test doubles are named and
  confined to test files; no automatic publishing or deployment was added.
- **Resource abuse:** ffmpeg-intensive routes are rate-limited to 20 requests
  per minute in addition to the global 100/min limit.

## Secret scan

Staged/committed diff scanned for key/token/password/private-key patterns: only
test-fixture passwords (`password1234` in integration tests) and variable names
appear. No real secret value was committed.
