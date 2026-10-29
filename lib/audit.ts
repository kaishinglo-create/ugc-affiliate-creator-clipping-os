import { prisma } from './db.js';

export type AuditEventInput = {
  workspaceId?: string | null;
  userId?: string | null;
  runId?: string | null;
  type: string;
  actor?: string | null;
  data?: unknown;
  tx?: any;
};

export async function writeAuditEvent(input: AuditEventInput) {
  const tx = input.tx ?? prisma;
  return tx.auditEvent.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      type: input.type,
      actor: input.actor ?? null,
      data: input.data === undefined ? null : (input.data as any),
    },
  });
}
