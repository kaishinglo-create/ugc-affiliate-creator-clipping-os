# Phase G Security Audit (2026-11-27)

Scope: `feature/phase-g-completion-2026-11-27` (commits `9f8efc9`, `b685a7b`).
Method: read-only source review plus targeted greps. No `.env` values were read
or reproduced. The dedicated security subagent was unavailable
(`Model unavailable: ollama-cloud/beam`), so this audit was performed manually.

## Findings

No Critical or High severity finding was identified in the new Phase G code.

### CLOSED — DNS rebinding / connection TOCTOU (`src/media-download.ts`)

Previously DNS was validated but discarded before `fetch`. Now every hop is
resolved and validated, one validated address is selected, and an undici `Agent`
pins the socket lookup to that address; the resolver is never called again at
connect time. Redirects are re-resolved and re-pinned per hop with a fresh agent
(closed in `finally`), so stale pooled sockets cannot leak a previous pin. IPv4
and IPv6 classification covers private/loopback/link-local/multicast/reserved/
documentation ranges plus IPv4-mapped, IPv4-compatible, NAT64 and 6to4 embedded
forms; family mismatches and malformed literals fail closed. TLS certificate
verification stays enabled (`rejectUnauthorized: true`) and SNI/hostname stays
the URL hostname — the URL is never rewritten to the pinned IP.

Verified locally with `tests/media-download-pinning.test.ts` (rebinding lookup
that flips from public to link-local, per-hop pin assertions, TLS/SNI check with
a self-signed local certificate) and `tests/media-download.test.ts`.

Residual: no live public-host download was performed; production pinning is
verified with injected DNS/transport doubles plus a real local TLS socket test.

### CLOSED — member persisted `ResearchReport` (`src/index.ts`, `src/research-reports.ts`)

`POST /api/discovery/score` now calls `requireOperatorRole` for `persist: true`
while non-persistent member scoring remains available. The persistence module
itself additionally requires `role: OWNER | ADMIN` and fails closed with 403
`INSUFFICIENT_ROLE` when the role is missing or a MEMBER. Regression coverage in
`tests/research-reports.test.ts` asserts member scoring 200, member persist 403,
no stored row after the denied write, and module-level enforcement.

## Confirmed controls

- **Auth/roles:** all new mutating media, release, pipeline and persistent
  research-report routes call `requireAuthWorkspace` and `requireOperatorRole`;
  the persistence module also enforces OWNER/ADMIN. Read routes require
  `requireAuthWorkspace`. No unauthenticated path was added.
- **RLS / workspace isolation:** `src/research-reports.ts`,
  `src/media-download.ts`, `src/media-release.ts` and `src/phase-g-pipeline.ts`
  contain **no** direct global `prisma.*` access; every query runs through
  `withWorkspaceTransaction` (4/3/4/4 call sites respectively).
- **SSRF:** literal IPv4/IPv6, loopback, RFC1918, link-local, multicast,
  CGNAT, `.local`, `.localhost`, `.internal`, credentials-bearing URLs,
  non-http(s) schemes, private DNS answers and redirects to private addresses
  are rejected. Each hop's validated IP is pinned at socket level; TLS
  verification and hostname/SNI checks remain active. Downloads are bounded by
  content type, 30 s timeout per hop and the existing 8 MiB upload cap;
  oversize streams are cancelled.
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
