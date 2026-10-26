# Phase 6 Baseline

- Workflow engine: WorkflowDefinition, WorkflowRun, WorkflowStepRun (workspace-scoped, RLS).
- Actions: echo, delay (registry).
- Endpoints: create/list workflows, run, get run.
- Idempotency via workspaceId+idempotencyKey unique.
- Tests: 15 passed (added 2 workflow tests).
