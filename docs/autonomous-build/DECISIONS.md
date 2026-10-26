# Architecture Decision Log

## 2026-10-26 — Standalone boundary
**Decision:** All runtime components and agents belong in this repository. No CarryOS dependency.  
**Reason:** The product must work independently.  
**Consequence:** Auth, workflow orchestration, agent runtime, AI gateway, approvals, audit and connectors must be implemented here.

## 2026-10-26 — Honest UI foundation
**Decision:** Begin with a dependency-free UI and local Node.js server.  
**Reason:** Repository started empty; runnable foundations are better than claiming a nonexistent platform.  
**Consequence:** Records are session-only demo data; external integrations remain disconnected.

## 2026-10-26 — Verified AI adapters
**Decision:** AI providers must use documented typed adapters. Beam Free is used only if configured and available. JEV is not implemented until its API is verified.  
**Reason:** Avoid invented APIs, accidental paid usage and false connectivity claims.

## 2026-10-26 — Human approval for external effects
**Decision:** Publishing, outreach, spending and irreversible actions require explicit approval.  
**Reason:** Protect accounts, budgets, rights and user trust.
