# API (Phase 3)

- GET /health -> { status: "ok" }
- GET /ready -> { status: "ready" } (DB check)
- POST /api/auth/signup body { email, password, name?, workspaceName, workspaceSlug } -> 201
- POST /api/auth/login body { email, password } -> 200 + cookie
- POST /api/auth/logout -> 200
- GET /api/auth/me -> user + workspaces (requires session)
- POST /api/items headers x-workspace-id, body { title } -> 201 (member)
- GET /api/items?limit&offset headers x-workspace-id -> { items, limit, offset } (member)

Errors: { error: CODE } with HTTP status.
