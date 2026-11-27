import { PrismaClient } from '../src/generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { newSpan, trace } from '../src/qa-trace.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const globalForPrisma = globalThis as unknown as { __ugcPrisma?: PrismaClient };

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });

export const prisma = globalForPrisma.__ugcPrisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__ugcPrisma = prisma;
}

export async function withWorkspaceTransaction<T>(workspaceId: string, work: (tx: any) => Promise<T>): Promise<T> {
  if (typeof workspaceId !== 'string' || !ID_RE.test(workspaceId)) {
    throw new Error('INVALID_WORKSPACE_ID');
  }
  const span = newSpan();
  const queuedAt = Date.now();
  trace('db_tx.start', { span, workspaceId });
  try {
    return await prisma.$transaction(async (tx) => {
      trace('db_tx.acquired', { span, workspaceId, waitMs: Date.now() - queuedAt });
      await tx.$executeRawUnsafe(`select set_config('app.current_workspace_id', $1, true)`, workspaceId);
      return work(tx);
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (error) {
    trace('db_tx.error', { span, workspaceId, durationMs: Date.now() - queuedAt, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  } finally {
    trace('db_tx.end', { span, workspaceId, durationMs: Date.now() - queuedAt });
  }
}

export async function withUserContext<T>(userId: string, work: (tx: any) => Promise<T>): Promise<T> {
  if (typeof userId !== 'string' || !ID_RE.test(userId)) {
    throw new Error('INVALID_USER_ID');
  }
  const span = newSpan();
  const queuedAt = Date.now();
  trace('db_tx.start', { span, userId, context: 'user' });
  try {
    return await prisma.$transaction(async (tx) => {
      trace('db_tx.acquired', { span, userId, waitMs: Date.now() - queuedAt, context: 'user' });
      await tx.$executeRawUnsafe(`select set_config('app.current_user_id', $1, true)`, userId);
      return work(tx);
    });
  } catch (error) {
    trace('db_tx.error', { span, userId, context: 'user', durationMs: Date.now() - queuedAt, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    throw error;
  } finally {
    trace('db_tx.end', { span, userId, context: 'user', durationMs: Date.now() - queuedAt });
  }
}
