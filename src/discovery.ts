import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeAuditEvent } from '../lib/audit.js';
import { withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import { cancelJob, completeJob, createJob, failJob, heartbeatJob } from './jobs.js';

const querySchema = z.string().trim().min(1).max(200).refine((query) => !query.includes('\0'));
export const discoveryInput = z.object({ query: querySchema, runAt: z.iso.datetime({ offset: true }).optional() });

const providerResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), class: z.string().regex(/^[a-z_]{1,40}$/) }),
  z.object({ ok: z.literal(true), tier: z.literal(1), candidates: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    title: z.string().trim().min(1).max(500),
    channel: z.string().max(250).optional(),
  })).max(20) }),
]);

const runClient = promisify(execFile);
const dailyLimit = 10;
const reservationType = 'content_discovery_request_reserved';

export function discoveryEnabled() {
  return isAbsolute(process.env.DISCOVERY_MCP_CLIENT ?? '');
}

export async function enqueueDiscovery(workspaceId: string, input: z.infer<typeof discoveryInput>) {
  const runAt = input.runAt ? new Date(input.runAt) : new Date();
  const hour = Math.floor(Math.max(runAt.getTime(), Date.now()) / 3_600_000);
  const hash = createHash('sha256').update(input.query).digest('hex');
  return createJob({
    workspaceId, type: 'CONTENT_DISCOVERY', category: 'youtube_search', payload: { query: input.query },
    idempotencyKey: `discovery:youtube:${hour}:${hash}`, runAt, maxAttempts: 2,
  });
}

export async function listDiscoveryCandidates(workspaceId: string) {
  const rows: any[] = await withWorkspaceTransaction(workspaceId, (tx) => tx.discoveryCandidate.findMany({
    where: { workspaceId }, orderBy: [{ firstFoundAt: 'desc' }, { externalId: 'asc' }], take: 100,
  }));
  return rows.map(({ workspaceId: _workspaceId, ...row }) => ({
    ...row, url: `https://www.youtube.com/watch?v=${row.externalId}`,
  }));
}

export async function executeDiscovery(workspaceId: string, job: { id: string; leaseId: string; payload: unknown }, workerId: string, leaseTtlMs: number): Promise<{ outcome: 'succeeded' | 'failed' | 'retry' | 'skipped'; error?: string }> {
  const lease = { workspaceId, leaseId: job.leaseId, workerId };
  const query = z.object({ query: querySchema }).safeParse(job.payload);
  const client = process.env.DISCOVERY_MCP_CLIENT ?? '';
  const fail = async (error: string, retryable = false) => {
    const updated = await failJob(job.id, { error, retryable }, lease);
    const outcome = updated?.status === 'RETRY_WAIT' ? 'retry' as const :
      ['FAILED', 'DEAD_LETTER'].includes(updated?.status) ? 'failed' as const : 'skipped' as const;
    return { outcome, error };
  };
  if (!query.success || !isAbsolute(client)) return fail('DISCOVERY_INVALID_CONFIGURATION');

  const fence = async (tx: any) => {
    const rows: { id: string }[] = await tx.$queryRaw`
      SELECT id FROM "Job" WHERE id = ${job.id} AND "workspaceId" = ${workspaceId}
        AND "leaseId" = ${job.leaseId} AND "leaseOwner" = ${workerId}
        AND status = 'RUNNING' AND "leaseExpiresAt" > ${new Date()} FOR UPDATE
    `;
    return rows.length === 1;
  };
  const reserve = await withWorkspaceTransaction(workspaceId, async (tx) => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${reservationType + ':' + workspaceId}, 0))`;
    if (!(await fence(tx))) return 'lost';
    if (await isKillSwitchActive(workspaceId, tx)) {
      await cancelJob(job.id, { ...lease, reason: 'KILL_SWITCH_ACTIVE' }, tx);
      return 'blocked';
    }
    const used = await tx.auditEvent.count({ where: { workspaceId, type: reservationType, createdAt: { gte: day } } });
    if (used >= dailyLimit) return 'budget';
    await writeAuditEvent({ workspaceId, type: reservationType, data: { jobId: job.id, source: 'youtube' }, tx });
    return 'reserved';
  });
  if (reserve === 'budget') return fail('DISCOVERY_DAILY_BUDGET_EXCEEDED');
  if (reserve !== 'reserved') return { outcome: 'skipped' as const };

  const timer = setInterval(() => {
    void heartbeatJob(job.id, job.leaseId, workerId, { workspaceId, extendMs: leaseTtlMs }).catch(() => undefined);
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
  timer.unref();
  try {
    let raw: string;
    try {
      const { stdout } = await runClient(process.execPath, [client, query.data.query, '--worker'], {
        timeout: 38_000, maxBuffer: 128 * 1024,
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
          ['PATH', 'HOME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS'].includes(name))),
      });
      raw = stdout;
    } catch {
      return await fail('DISCOVERY_MCP_UNAVAILABLE', true);
    }

    let parsed: ReturnType<typeof providerResponse.safeParse>;
    try {
      parsed = providerResponse.safeParse(JSON.parse(raw));
    } catch {
      return await fail('DISCOVERY_INVALID_RESULT');
    }
    if (!parsed.success) return await fail('DISCOVERY_INVALID_RESULT');
    if (!parsed.data.ok) return await fail(`DISCOVERY_PROVIDER_${parsed.data.class.toUpperCase()}`);
    const candidates = parsed.data.candidates;
    return await withWorkspaceTransaction(workspaceId, async (tx) => {
      if (!(await fence(tx))) return { outcome: 'skipped' as const };
      if (await isKillSwitchActive(workspaceId, tx)) {
        await cancelJob(job.id, { ...lease, reason: 'KILL_SWITCH_ACTIVE' }, tx);
        return { outcome: 'skipped' as const };
      }
      const inserted = candidates.length ? await tx.discoveryCandidate.createMany({
        data: candidates.map(({ id, title, channel }) => ({ workspaceId, source: 'youtube', externalId: id, title, channel })),
        skipDuplicates: true,
      }) : { count: 0 };
      await completeJob(job.id, lease, tx);
      await writeAuditEvent({ workspaceId, type: 'content_discovery_completed', data: { jobId: job.id, received: candidates.length, inserted: inserted.count }, tx });
      return { outcome: 'succeeded' as const };
    });
  } finally {
    clearInterval(timer);
  }
}
