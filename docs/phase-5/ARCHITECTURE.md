# Phase 5 Architecture

- Data: Niche, Product, ContentIdea belong to Workspace.
- RLS: workspace isolation via current_workspace_id().
- API: REST under /api/* with session + membership.
- Scoring: pure function, no external deps.
