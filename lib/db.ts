import { PrismaClient } from '../src/generated/prisma/index.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const globalForPrisma = globalThis as unknown as { __ugcPrisma?: PrismaClient };

export const prisma = globalForPrisma.__ugcPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__ugcPrisma = prisma;
}

export async function withWorkspaceTransaction<T>(workspaceId: string, work: (tx: any) => Promise<T>): Promise<T> {
  if (typeof workspaceId !== 'string' || !ID_RE.test(workspaceId)) {
    throw new Error('INVALID_WORKSPACE_ID');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`select set_config('app.current_workspace_id', $1, true)`, workspaceId);
    return work(tx);
  });
}

export async function withUserContext<T>(userId: string, work: (tx: any) => Promise<T>): Promise<T> {
  if (typeof userId !== 'string' || !ID_RE.test(userId)) {
    throw new Error('INVALID_USER_ID');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`select set_config('app.current_user_id', $1, true)`, userId);
    return work(tx);
  });
}
