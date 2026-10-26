# Security Review (Phase 4)

- Security headers via helmet.
- Graceful shutdown prevents abrupt connection drops.
- DB role is NOSUPERUSER/NOBYPASSRLS in CI and local (ugc_os_app).
- RLS on Item enforced; tests pass as non-superuser.
- Remaining: audit logging, CSRF token (SameSite=Lax + CORS origin), dependency audit.
