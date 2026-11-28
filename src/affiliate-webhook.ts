/**
 * Affiliate provider webhooks: HMAC verification and replay protection.
 *
 * No event is accepted without a valid signature over the exact raw body and a
 * fresh timestamp. Values are always taken from the signed provider payload;
 * this module never derives or invents an amount or commission.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';

const MAX_AGE_MS = 5 * 60_000;

function invalid(code: string): Error {
  return Object.assign(new Error(code), { statusCode: 400 });
}

export function verifyAffiliateWebhookSignature(input: {
  rawBody: string;
  signature: string;
  secret: string;
  timestamp?: string;
  workspaceId: string;
  provider: string;
  now?: Date;
}): boolean {
  const secret = String(input.secret ?? '');
  const signature = String(input.signature ?? '').replace(/^sha256=/i, '');
  const workspaceId = String(input.workspaceId ?? '');
  const provider = String(input.provider ?? '');
  if (!secret || !workspaceId || !provider || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const timestamp = Number(input.timestamp);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_AGE_MS) return false;
  // Binding the signature to workspace and provider prevents a valid payload
  // from being replayed against another workspace or provider endpoint.
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${workspaceId}.${provider}.${input.rawBody}`)
    .digest('hex');
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(signature.toLowerCase(), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Persist a provider-confirmed conversion exactly once. */
export async function applyAffiliateWebhookConversion(input: {
  workspaceId: string;
  provider: string;
  externalEventId: string;
  clickId?: string | null;
  amountCents: number;
  commissionCents?: number | null;
  currency?: string | null;
  actor: string;
}): Promise<{ conversion: any; duplicate: boolean }> {
  const externalEventId = String(input.externalEventId ?? '').trim().slice(0, 200);
  if (!externalEventId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(externalEventId)) throw invalid('INVALID_EVENT_ID');
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw invalid('INVALID_AMOUNT');
  if (input.commissionCents !== undefined && input.commissionCents !== null
    && (!Number.isInteger(input.commissionCents) || input.commissionCents < 0)) throw invalid('INVALID_COMMISSION');

  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const existing: any = await tx.affiliateConversion.findFirst({
      where: { workspaceId: input.workspaceId, externalEventId },
    });
    if (existing) return { conversion: existing, duplicate: true };
    const clickId = input.clickId ? String(input.clickId).trim().slice(0, 64) : null;
    const click = clickId
      ? await tx.affiliateClick.findFirst({ where: { id: clickId, workspaceId: input.workspaceId } })
      : null;
    if (clickId && !click) throw invalid('INVALID_CLICK_ID');
    const conversion: any = await tx.affiliateConversion.create({
      data: {
        workspaceId: input.workspaceId,
        clickId: click?.id ?? null,
        amountCents: input.amountCents,
        commissionCents: input.commissionCents ?? null,
        currency: input.currency ? String(input.currency).toUpperCase().slice(0, 8) : null,
        status: 'pending',
        externalEventId,
        idempotencyKey: `webhook:${input.provider}:${externalEventId}`.slice(0, 200),
      },
    });
    await writeAuditEvent({
      tx,
      workspaceId: input.workspaceId,
      userId: null,
      runId: null,
      type: 'affiliate_webhook_conversion',
      actor: input.actor,
      data: { provider: input.provider, conversionId: conversion.id, externalEventId, amountCents: input.amountCents },
    });
    return { conversion, duplicate: false };
  });
}
