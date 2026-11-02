# MECE WAVE 02 — Audit Mode (read-only)

Goal:
Run an independent read-only audit of frontend, API, and security surfaces in the current UGC Affiliate Creator Clipping OS working tree.

Global rules:
- READ ONLY. Do not modify product source, tests, configuration, migrations, MCP state, reports from cells other than the assigned one, or repository data.
- Each assigned auditor may create/update only its own `REPORT.md`.
- No commits, deployments, resets, stashes, cleanup, or test database mutations.
- No paid API calls or model calls.
- No secrets may be printed, exported, or copied into reports.
- Findings must be classified by criticality (Critical / High / Medium / Low / Informational).
- Claims must distinguish verified, partially verified, unverified, and blocked.

Disjunctive cell ownership:
- `wave-02/frontend-audit`: frontend-auditor. Owns `.mece/wave-02/cells/frontend-audit/REPORT.md`; reviews browser-facing UI, form behavior, responsive layout, client error handling, and frontend smoke evidence.
- `wave-02/api-audit`: api-auditor. Owns `.mece/wave-02/cells/api-audit/REPORT.md`; reviews Fastify API, Ollama/API surface, workflows, job runtime, error mapping, validation, and external provider behavior.
- `wave-02/security-audit`: security-auditor. Owns `.mece/wave-02/cells/security-audit/REPORT.md`; reviews authentication, workspace scoping, RLS/migrations, secrets, proxy/control-center exposure, file access, and test evidence.

Shared rule:
Auditors may read adjacent files and tests for evidence, but must not modify files outside their assigned report directory.

Required report contents:
- scope
- evidence and commands/checks
- verified findings
- partially verified / blocked findings
- open risks
- blockers
- confidence
