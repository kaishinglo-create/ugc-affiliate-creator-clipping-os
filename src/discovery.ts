import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { writeAuditEvent } from '../lib/audit.js';
import { withWorkspaceTransaction } from '../lib/db.js';
import { isKillSwitchActive } from '../lib/security.js';
import { cancelJob, completeJob, createJob, failJob, getJob, heartbeatJob } from './jobs.js';
import { McpStdioClient } from './mcp-client.js';

const querySchema = z.string().trim().min(1).max(200).refine((query) => !query.includes('\0'));
export const discoveryInput = z.object({ query: querySchema, runAt: z.iso.datetime({ offset: true }).optional() });
export const discoveryScheduleInput = z.object({
  query: querySchema,
  intervalMinutes: z.number().int().min(15).max(10_080),
  runAt: z.iso.datetime({ offset: true }).optional(),
});

const providerResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(false), class: z.string().regex(/^[a-z_]{1,40}$/) }),
  z.object({ ok: z.literal(true), tier: z.literal(1), candidates: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    title: z.string().trim().min(1).max(500),
    channel: z.string().max(250).optional(),
  })).max(20), nextCursor: z.string().min(1).max(512).optional() }),
]);

const runClient = promisify(execFile);
const dailyLimit = 10;
const reservationType = 'content_discovery_request_reserved';
const MCP_TOOL = 'youtube_search';
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  ['PATH', 'HOME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS'].includes(name)));

/** Absolute path of the MCP server to connect to over stdio. */
export function discoveryServerPath() {
  const server = process.env.DISCOVERY_MCP_SERVER ?? '';
  return isAbsolute(server) ? server : null;
}

/** Legacy one-shot client script; still supported for existing deployments. */
function discoveryClientPath() {
  const client = process.env.DISCOVERY_MCP_CLIENT ?? '';
  return isAbsolute(client) ? client : null;
}

export function discoveryEnabled() {
  return discoveryServerPath() !== null || discoveryClientPath() !== null;
}

/** Stable, workspace-independent policy key for a query's pagination cursor. */
export function discoveryCursorKey(query: string): string {
  return `discovery.cursor.youtube.${createHash('sha256').update(query).digest('hex').slice(0, 32)}`;
}

/** Bounded exponential backoff; retries still consume the daily provider budget. */
export function discoveryBackoffMs(attempt: number, baseMs = 30_000, capMs = 300_000): number {
  const boundedAttempt = Math.max(1, Math.min(10, Math.trunc(Number(attempt) || 1)));
  return Math.min(capMs, baseMs * 2 ** (boundedAttempt - 1));
}

/** Read the stored pagination cursor for a query (null when none is stored). */
export async function getDiscoveryCursor(workspaceId: string, query: string): Promise<string | null> {
  return readDiscoveryCursor(workspaceId, query);
}

async function readDiscoveryCursor(workspaceId: string, query: string): Promise<string | null> {
  const key = discoveryCursorKey(query);
  const row: any = await withWorkspaceTransaction(workspaceId, (tx) =>
    tx.operationalPolicy.findUnique({ where: { workspaceId_key: { workspaceId, key } } }));
  const value = row?.value;
  const cursor = value && typeof value === 'object' ? (value as any).cursor : null;
  return typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512 ? cursor : null;
}

async function writeDiscoveryCursor(workspaceId: string, query: string, cursor: string | undefined): Promise<void> {
  if (cursor === undefined) return;
  const key = discoveryCursorKey(query);
  await withWorkspaceTransaction(workspaceId, async (tx) => {
    if (cursor.length === 0 || cursor.length > 512) {
      await tx.operationalPolicy.deleteMany({ where: { workspaceId, key } });
      return;
    }
    await tx.operationalPolicy.upsert({
      where: { workspaceId_key: { workspaceId, key } },
      create: { workspaceId, key, value: { cursor, query } },
      update: { value: { cursor, query } },
    });
  });
}

/**
 * Connect to the API Anything pilot as a real MCP client, verify the search
 * tool is exposed, and invoke it. Throws on transport or tool failures; the
 * caller maps those to the provider failure classes.
 */
async function searchViaMcp(serverPath: string, query: string, cursor?: string): Promise<unknown> {
  const client = await McpStdioClient.connect({
    command: process.execPath,
    args: [serverPath],
    env: childEnv(),
    connectTimeoutMs: 10_000,
  });
  try {
    const tools = await client.listTools();
    if (!tools.some((tool) => tool.name === MCP_TOOL)) throw new Error('MCP_TOOL_MISSING');
    const result = await client.callTool(MCP_TOOL, cursor ? { query, cursor } : { query }, 30_000);
    if (result.isError) throw new Error('MCP_TOOL_ERROR');
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error('MCP_EMPTY_RESULT');
    return JSON.parse(text);
  } finally {
    client.close();
  }
}

export async function enqueueDiscovery(workspaceId: string, input: z.infer<typeof discoveryInput>) {
  const runAt = input.runAt ? new Date(input.runAt) : new Date();
  const hour = Math.floor(Math.max(runAt.getTime(), Date.now()) / 3_600_000);
  const hash = createHash('sha256').update(input.query).digest('hex');
  const cursor = await readDiscoveryCursor(workspaceId, input.query);
  return createJob({
    workspaceId, type: 'CONTENT_DISCOVERY', category: 'youtube_search',
    payload: cursor ? { query: input.query, cursor } : { query: input.query },
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

export async function createDiscoverySchedule(workspaceId: string, input: z.infer<typeof discoveryScheduleInput>): Promise<any> {
  const firstRunAt = input.runAt ? new Date(input.runAt) : new Date(Date.now() + input.intervalMinutes * 60_000);
  return withWorkspaceTransaction<any>(workspaceId, (tx) => tx.discoverySchedule.create({
    data: { workspaceId, query: input.query, intervalMinutes: input.intervalMinutes, nextRunAt: firstRunAt },
  }));
}

export async function listDiscoverySchedules(workspaceId: string): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx) => tx.discoverySchedule.findMany({
    where: { workspaceId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100,
  }));
}

export async function deleteDiscoverySchedule(workspaceId: string, id: string): Promise<boolean> {
  const result: any = await withWorkspaceTransaction<any>(workspaceId, (tx) =>
    tx.discoverySchedule.deleteMany({ where: { id, workspaceId } })
  );
  return result?.count === 1;
}

/** Advance a missed schedule past `now` while keeping its interval cadence. */
function nextScheduleRun(from: Date, intervalMinutes: number, now: Date): Date {
  const step = Math.max(1, intervalMinutes) * 60_000;
  let next = new Date(from.getTime() + step);
  for (let guard = 0; next <= now && guard < 1_000; guard += 1) {
    next = new Date(next.getTime() + step);
  }
  return next;
}

/**
 * Queue one job per due recurring schedule and advance its `nextRunAt` in the
 * same transaction. The advisory lock serialises concurrent engine ticks, so a
 * due schedule is queued exactly once even with several workers.
 */
export async function enqueueDueDiscoverySchedules(workspaceId: string, now = new Date()): Promise<number> {
  return withWorkspaceTransaction(workspaceId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`discovery_schedules:${workspaceId}`}, 0))`;
    const due = await tx.discoverySchedule.findMany({
      where: { workspaceId, enabled: true, nextRunAt: { lte: now } },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    let queued = 0;
    for (const schedule of due) {
      const advanced = await tx.discoverySchedule.updateMany({
        where: { id: schedule.id, workspaceId, nextRunAt: schedule.nextRunAt },
        data: { lastRunAt: schedule.nextRunAt, nextRunAt: nextScheduleRun(schedule.nextRunAt, schedule.intervalMinutes, now) },
      });
      if (advanced.count !== 1) continue;
      await createJob({
        workspaceId, type: 'CONTENT_DISCOVERY', category: 'youtube_search',
        payload: { query: schedule.query, scheduleId: schedule.id },
        idempotencyKey: `discovery:schedule:${schedule.id}:${schedule.nextRunAt.getTime()}`,
        runAt: now, maxAttempts: 2,
      }, tx);
      queued += 1;
    }
    return queued;
  });
}

export async function executeDiscovery(workspaceId: string, job: { id: string; leaseId: string; payload: unknown }, workerId: string, leaseTtlMs: number): Promise<{ outcome: 'succeeded' | 'failed' | 'retry' | 'skipped'; error?: string }> {
  const lease = { workspaceId, leaseId: job.leaseId, workerId };
  const query = z.object({ query: querySchema, cursor: z.string().min(1).max(512).optional() }).safeParse(job.payload);
  const server = discoveryServerPath();
  const client = discoveryClientPath();
  const fail = async (error: string, retryable = false) => {
    const nextRunAt = retryable
      ? new Date(Date.now() + discoveryBackoffMs(Number((await getJob(job.id, workspaceId))?.attempts ?? 1)))
      : null;
    const updated = await failJob(job.id, { error, retryable, nextRunAt }, lease);
    const outcome = updated?.status === 'RETRY_WAIT' ? 'retry' as const :
      ['FAILED', 'DEAD_LETTER'].includes(updated?.status) ? 'failed' as const : 'skipped' as const;
    return { outcome, error };
  };
  if (!query.success || (!server && !client)) return fail('DISCOVERY_INVALID_CONFIGURATION');

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
    let result: unknown;
    try {
      if (server) {
        result = await searchViaMcp(server, query.data.query, query.data.cursor);
      } else {
        // `--` makes the query positional for CLIs that parse options; a query
        // like `--help` must never be interpreted as a client flag.
        const args = [client!, '--', query.data.query];
        if (query.data.cursor) args.push('--cursor', query.data.cursor);
        args.push('--worker');
        const { stdout } = await runClient(process.execPath, args, {
          timeout: 38_000, maxBuffer: 128 * 1024, env: childEnv(),
        });
        try {
          result = JSON.parse(stdout);
        } catch {
          return await fail('DISCOVERY_INVALID_RESULT');
        }
      }
    } catch {
      return await fail('DISCOVERY_MCP_UNAVAILABLE', true);
    }

    const parsed = providerResponse.safeParse(result);
    if (!parsed.success) return await fail('DISCOVERY_INVALID_RESULT');
    if (!parsed.data.ok) {
      const retryableClass = ['rate_limited', 'quota', 'unavailable'].includes(parsed.data.class);
      return await fail(`DISCOVERY_PROVIDER_${parsed.data.class.toUpperCase()}`, retryableClass);
    }
    const candidates = parsed.data.candidates;
    const nextCursor = parsed.data.nextCursor;
    const completed = await withWorkspaceTransaction(workspaceId, async (tx) => {
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
      await writeAuditEvent({
        workspaceId,
        type: 'content_discovery_completed',
        data: { jobId: job.id, received: candidates.length, inserted: inserted.count, cursorAdvanced: Boolean(nextCursor) },
        tx,
      });
      return { outcome: 'succeeded' as const, nextCursor };
    });
    if (completed.outcome === 'succeeded') {
      await writeDiscoveryCursor(workspaceId, query.data.query, (completed as any).nextCursor);
    }
    return { outcome: completed.outcome };
  } finally {
    clearInterval(timer);
  }
}
