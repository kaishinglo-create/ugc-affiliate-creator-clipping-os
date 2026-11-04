import { prisma } from './db.js';

/**
 * `tx` is required on purpose: `KillSwitch` is protected by forced row-level
 * security, so a client without `app.current_workspace_id` set cannot see the
 * row at all and would silently report "inactive". Callers must pass a
 * workspace-scoped transaction (see `withWorkspaceTransaction`).
 */
export async function isKillSwitchActive(workspaceId: string, tx: any) {
  if (!tx) throw new Error('KILL_SWITCH_REQUIRES_WORKSPACE_TRANSACTION');
  const ks = await tx.killSwitch.findUnique({ where: { workspaceId } });
  return ks?.active === true;
}

export async function activateKillSwitch(workspaceId: string, reason: string, activatedBy: string, tx: any = prisma) {
  return tx.killSwitch.upsert({
    where: { workspaceId },
    create: { workspaceId, active: true, reason, activatedBy, activatedAt: new Date() },
    update: { active: true, reason, activatedBy, activatedAt: new Date() },
  });
}

export async function deactivateKillSwitch(workspaceId: string, tx: any = prisma) {
  return tx.killSwitch.upsert({
    where: { workspaceId },
    create: { workspaceId, active: false },
    update: { active: false, reason: null, activatedBy: null, activatedAt: null },
  });
}

export async function logSecurityEvent(workspaceId: string, type: string, result: string, tx: any = prisma, details?: string, actor?: string, agent?: string, action?: string, correlationId?: string) {
  return tx.securityEvent.create({ data: { workspaceId, type, result, details, actor, agent, action, correlationId } });
}
