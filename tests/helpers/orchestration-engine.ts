import { expect, vi } from 'vitest';
import { runEngineTick } from '../../src/engine.js';
import { getOrchestrationRun } from '../../src/orchestration.js';

export async function driveOrchestrationTo(workspaceId: string, runId: string, status: string) {
  const tick = await runEngineTick({ workspaceId, resumeOrchestrations: true });
  expect(tick.orchestrationsResumed).toBe(1);
  return vi.waitFor(async () => {
    const run = await getOrchestrationRun(workspaceId, runId);
    expect(run?.status).toBe(status);
    expect(run?.leaseOwner).toBeNull();
    return run;
  }, { timeout: 5_000 });
}
