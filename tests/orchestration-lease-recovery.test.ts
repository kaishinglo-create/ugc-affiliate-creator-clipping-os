import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { runAgentTask } from '../src/ai/agent-runtime.js';
import { createOrchestrationRun, getOrchestrationRun, runOrchestration } from '../src/orchestration.js';
import { claimOrchestrationLease } from '../src/orchestration-lease.js';

vi.mock('../src/ai/agent-runtime.js', () => ({ runAgentTask: vi.fn() }));

describe('persistent orchestration lease recovery', () => {
  it('rejects a concurrent driver and discards the old result after takeover', async () => {
    const workspaceId = randomUUID();
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Lease recovery', slug: workspaceId } });

    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let finishOldTask!: (output: Record<string, string>) => void;
    const oldResult = new Promise<Record<string, string>>((resolve) => { finishOldTask = resolve; });
    vi.mocked(runAgentTask).mockImplementationOnce(() => {
      signalStarted();
      return oldResult;
    }).mockResolvedValue({ worker: 'new' });

    let first: Promise<unknown> | undefined;
    try {
      const run = await createOrchestrationRun(workspaceId, { goal: 'Lease recovery' });
      // Exercise the normal driver on one task so the takeover reaches a
      // terminal state without needing to arrange a publishing approval.
      await withWorkspaceTransaction(workspaceId, (tx) =>
        tx.orchestrationTask.deleteMany({ where: { runId: run.id, departmentKey: { not: 'ceo' } } })
      );
      first = runOrchestration(workspaceId, run.id);
      await Promise.race([started, first.then(() => { throw new Error('First worker exited before starting its task'); })]);
      expect(await claimOrchestrationLease(workspaceId, run.id, 'concurrent-worker')).toBeNull();
      const active = await getOrchestrationRun(workspaceId, run.id);
      const task = active.tasks.find((entry: { status: string }) => entry.status === 'running');
      expect(task?.jobId).toBeTruthy();

      // Leave the leases behind as a crashed process would, without waiting for
      // wall-clock time. Keep its old result pending to model a stale worker.
      await withWorkspaceTransaction(workspaceId, async (tx) => {
        const expiredAt = new Date(0);
        await tx.orchestrationRun.update({ where: { id: run.id }, data: { leaseExpiresAt: expiredAt } });
        await tx.job.update({ where: { id: task.jobId }, data: { leaseExpiresAt: expiredAt } });
      });

      const recovered = await runOrchestration(workspaceId, run.id);
      expect(recovered.status).toBe('succeeded');
      expect(recovered.leaseEpoch).toBe(active.leaseEpoch + 1);
      const recoveredTask = recovered.tasks.find((entry: { id: string }) => entry.id === task.id);
      expect(recoveredTask.output).toEqual({ worker: 'new' });
      finishOldTask({ worker: 'old' });
      await first;
      const final = await getOrchestrationRun(workspaceId, run.id);
      expect(final.status).toBe('succeeded');
      expect(final.result).toEqual(recovered.result);
      expect(final.tasks.find((entry: { id: string }) => entry.id === task.id).output).toEqual({ worker: 'new' });
    } finally {
      finishOldTask({ worker: 'old' });
      await first?.catch(() => undefined);
      await prisma.workspace.delete({ where: { id: workspaceId } });
      await prisma.$disconnect();
    }
  }, 20_000);
});
