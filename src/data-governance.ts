/**
 * Local, workspace-scoped data governance helpers.
 *
 * These functions record consent decisions and allow an explicitly confirmed
 * deletion of stale affiliate rows. They are technical building blocks only;
 * no legal compliance or GDPR conformity is claimed.
 */
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';

export async function recordConsent(input: {
  workspaceId: string;
  actor: string | null;
  subjectId: string;
  purpose: string;
  granted: boolean;
}): Promise<any> {
  const subjectId = String(input.subjectId ?? '').trim().slice(0, 200);
  const purpose = String(input.purpose ?? '').trim().slice(0, 200);
  if (!subjectId || !purpose) throw Object.assign(new Error('INVALID_INPUT'), { statusCode: 400 });
  return withWorkspaceTransaction(input.workspaceId, (tx: any) => writeAuditEvent({
    tx,
    workspaceId: input.workspaceId,
    userId: input.actor,
    runId: null,
    type: input.granted ? 'data_consent_granted' : 'data_consent_revoked',
    actor: input.actor ?? 'operator',
    data: { subjectId, purpose },
  }));
}

export async function retentionReport(workspaceId: string): Promise<Record<string, unknown>> {
  return withWorkspaceTransaction(workspaceId, async (tx: any) => {
    const [clicks, conversions, links, oldestClick, oldestConversion] = await Promise.all([
      tx.affiliateClick.count({ where: { workspaceId } }),
      tx.affiliateConversion.count({ where: { workspaceId } }),
      tx.affiliateLink.count({ where: { workspaceId } }),
      tx.affiliateClick.findFirst({ where: { workspaceId }, orderBy: { clickedAt: 'asc' }, select: { clickedAt: true } }),
      tx.affiliateConversion.findFirst({ where: { workspaceId }, orderBy: { convertedAt: 'asc' }, select: { convertedAt: true } }),
    ]);
    return {
      clicks, conversions, links,
      oldestClickAt: oldestClick?.clickedAt ?? null,
      oldestConversionAt: oldestConversion?.convertedAt ?? null,
      missing: clicks === 0 && conversions === 0 ? 'NO_ROWS' : null,
      legalComplianceClaimed: false,
    };
  });
}

/** Explicitly confirmed deletion of stale rows in the caller's workspace only. */
export async function purgeStaleAffiliateData(input: {
  workspaceId: string;
  actor: string | null;
  olderThanDays: number;
  confirm: boolean;
}): Promise<{ deletedClicks: number; deletedConversions: number }> {
  if (!input.confirm) throw Object.assign(new Error('CONFIRM_REQUIRED'), { statusCode: 400 });
  const days = Math.trunc(Number(input.olderThanDays));
  if (!Number.isFinite(days) || days < 30 || days > 3650) {
    throw Object.assign(new Error('INVALID_RETENTION_PERIOD'), { statusCode: 400 });
  }
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const deletedConversions = (await tx.affiliateConversion.deleteMany({
      where: { workspaceId: input.workspaceId, convertedAt: { lt: cutoff }, status: { in: ['pending', 'rejected'] } },
    })).count;
    const referenced = await tx.affiliateConversion.findMany({
      where: { workspaceId: input.workspaceId, clickId: { not: null } },
      select: { clickId: true },
    });
    const protectedIds = referenced.map((row: any) => String(row.clickId));
    const deletedClicks = (await tx.affiliateClick.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        clickedAt: { lt: cutoff },
        ...(protectedIds.length ? { id: { notIn: protectedIds } } : {}),
      },
    })).count;
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'affiliate_retention_purge', actor: input.actor ?? 'operator',
      data: { olderThanDays: days, deletedClicks, deletedConversions, cutoff: cutoff.toISOString() },
    });
    return { deletedClicks, deletedConversions };
  });
}
