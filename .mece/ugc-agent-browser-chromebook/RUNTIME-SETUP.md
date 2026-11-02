# Runtime Setup

- Existing UGC adapter endpoint: `BROWSER_RUNTIME_URL`
- Existing auth header: `Authorization: Bearer <BROWSER_RUNTIME_TOKEN>`
- Required adapter routes:
  `/status`, `/sessions`, `/sessions/:id/navigate`, `/back`, `/forward`, `/reload`, `/tabs`, `/tabs/new`, `/tabs/close`, `/read`, `/click`, `/type`, `/screenshot`, `/wait`, `/download`, `/close`
- Existing UGC implementation is already compatible with this protocol.
