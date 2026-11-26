import { expect, vi } from 'vitest';
import { runEngineTick } from '../../src/engine.js';
import { getOrchestrationRun } from '../../src/orchestration.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export async function driveOrchestrationTo(workspaceId: string, runId: string, status: string) {
  const tick = await runEngineTick({ workspaceId, resumeOrchestrations: true });
  expect(tick.errors).toEqual([]);
  expect(tick.orchestrationsResumed).toBe(1);
  return vi.waitFor(async () => {
    const run = await getOrchestrationRun(workspaceId, runId);
    const actual = String(run?.status ?? '');
    // Fail fast on a different terminal state instead of waiting 30s while a
    // swallowed driver error leaves the run stuck at `running`.
    if (actual !== status && TERMINAL_STATUSES.has(actual)) {
      throw new Error(
        `Orchestration ${runId} reached ${actual} before ${status}${run?.error ? `: ${run.error}` : ''}`,
      );
    }
    expect(run?.status).toBe(status);
    expect(run?.leaseOwner).toBeNull();
    return run;
  }, { timeout: 30_000, interval: 250 });
}
