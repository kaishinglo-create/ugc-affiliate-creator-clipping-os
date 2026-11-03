# Quality Gates

Pass:
- TypeScript typecheck
- Full ESLint
- Health endpoint test
- Scheduler isolated test DB (5 tests)
- Scheduler DB recovery and retry tests

Not executed:
- Full Vitest suite against production DB, to avoid mutating production data
- Full integration suite in isolated database, pending env isolation support

Baseline risks:
- Node v26 instead of documented v22
- Prisma migrate fails on Android schema engine
- Android process lifecycle limits unattended runtime
- Default scheduler disabled
