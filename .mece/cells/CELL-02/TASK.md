# CELL-02 — Ollama and API Verification

READ-ONLY. Inspect:
- src/ollama.ts
- src/index.ts Ollama routes
- src/config.ts
- src/integrations.ts
- relevant tests and previous reports

Verify:
1. Authentication and workspace authorization boundaries.
2. Prompt length and input validation.
3. Timeout and upstream error handling.
4. Rate limits and cost-control limitations.
5. Whether API keys or upstream error details can leak.
6. Exact meaning of HTTP 402 and what cannot be tested without paid credits.
7. Whether Ollama is represented consistently in integration metadata.

No external model calls, no paid requests, no secret output.
Do not modify files.
Write only .mece/cells/CELL-02/REPORT.md.
