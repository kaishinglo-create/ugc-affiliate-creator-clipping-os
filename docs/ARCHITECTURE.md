# Target Architecture

This is a standalone application. There is no CarryOS dependency.

```text
Web UI -> Application API
  -> Authentication and authorization
  -> Product / Creator / Campaign / Content domains
  -> Workflow engine + durable job queue
  -> Internal Agent Runtime -> AI Gateway -> verified provider adapters
  -> Optional structured decision adapter (JEV only if verified)
  -> Human approval service + audit/event log
  -> Authorized video workers
  -> Affiliate, research, publishing and analytics adapters
Database + object storage + server-side secret manager
```

## Required guarantees
- Validate external inputs and model outputs.
- Keep credentials server-side.
- Enforce authorization at every server-side resource boundary.
- Use idempotency keys and bounded retry policies.
- Store provenance for research and analytics.
- Require approvals for external side effects.
- Label mock, demo, disconnected and production-ready states accurately.
- Enforce model and spend limits without silent provider fallback.
