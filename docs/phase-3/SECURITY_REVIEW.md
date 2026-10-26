# Security Review (Phase 3)

- Auth: bcrypt (12 rounds), JWT signed with SESSION_JWT_SECRET (>=32), HttpOnly/SameSite cookie.
- RLS: Item table FORCE RLS on workspaceId; requests use withWorkspaceTransaction.
- Workspace membership enforced server-side for items.
- Rate limiting: global 100/min, auth 10/min.
- CORS: allowed origin from CORS_ORIGIN (default localhost:5173), credentials.
- No secrets in code; .env gitignored.
- Readiness checks DB.
