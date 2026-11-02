# CELL-SECURITY — Security Audit (read-only)

Audit files:
- lib/auth.ts
- lib/db.ts
- lib/security.ts
- src/index.ts
- prisma/migrations/
- prisma/schema.prisma
- .mece-control/
- .opencode/
- relevant tests under tests/

Rules:
- No product changes.
- Write only REPORT.md in this directory.
- No secrets, credentials, or backup contents may be exposed.
- Report findings by criticality.
