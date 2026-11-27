import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { verifyAffiliateWebhookSignature } from '../src/affiliate-webhook.js';
import { publishingLocalTimeToUtc } from '../src/publishing.js';

const workspaceIds: string[] = [];
let app: any;

afterAll(async () => {
  vi.unstubAllEnvs();
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace() {
  const suffix = randomUUID();
  const email = `h5-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: 'Phase H test', workspaceSlug: `h5-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('Phase H webhook signature and timezone handling', () => {
  it('accepts a fresh HMAC and rejects tampering, wrong secrets and expired timestamps', () => {
    const secret = 'phase-h-test-secret';
    const now = new Date('2026-11-27T12:00:00Z');
    const body = '{"amountCents":1234,"externalEventId":"evt-1"}';
    const timestamp = String(now.getTime());
    const binding = { workspaceId: 'ws-test-1', provider: 'testnet' };
    const signature = createHmac('sha256', secret).update(`${timestamp}.${binding.workspaceId}.${binding.provider}.${body}`).digest('hex');
    expect(verifyAffiliateWebhookSignature({ rawBody: body, signature, secret, timestamp, now, ...binding })).toBe(true);
    expect(verifyAffiliateWebhookSignature({ rawBody: `${body} `, signature, secret, timestamp, now, ...binding })).toBe(false);
    expect(verifyAffiliateWebhookSignature({ rawBody: body, signature, secret: 'other', timestamp, now, ...binding })).toBe(false);
    expect(verifyAffiliateWebhookSignature({
      rawBody: body, signature, secret, timestamp: String(now.getTime() - 600_000), now, ...binding,
    })).toBe(false);
    expect(verifyAffiliateWebhookSignature({ rawBody: body, signature, secret, timestamp, now, ...binding, workspaceId: 'ws-test-2' })).toBe(false);
    expect(verifyAffiliateWebhookSignature({ rawBody: body, signature, secret, timestamp, now, ...binding, provider: 'other' })).toBe(false);
    expect(verifyAffiliateWebhookSignature({ rawBody: body, signature: 'short', secret, timestamp, now, ...binding })).toBe(false);
  });

  it('converts summer and winter local times correctly', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const summer = publishingLocalTimeToUtc('2026-07-15T12:00', 'Europe/Berlin', from);
    const winter = publishingLocalTimeToUtc('2026-01-15T12:00', 'Europe/Berlin', from);
    expect(summer?.toISOString()).toBe('2026-07-15T10:00:00.000Z');
    expect(winter?.toISOString()).toBe('2026-01-15T11:00:00.000Z');
    expect(publishingLocalTimeToUtc('not-a-time', 'Europe/Berlin', from)).toBeNull();
    expect(publishingLocalTimeToUtc('2026-07-15T12:00', 'Not/AZone', from)).toBeNull();
  });
});

describe('Phase H API gates and signed webhooks', () => {
  it('stores a signed provider conversion once and rejects replays', async () => {
    app = await buildServer();
    const { workspaceId } = await workspace();
    const secret = 'webhook-secret-for-tests';
    vi.stubEnv('AFFILIATE_WEBHOOK_SECRET_TESTNET', secret);
    const payload = { externalEventId: `evt-${randomUUID()}`, amountCents: 4321, commissionCents: 321, currency: 'EUR' };
    const raw = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', secret).update(`${timestamp}.${workspaceId}.testnet.${raw}`).digest('hex');
    const send = () => app.inject({
      method: 'POST',
      url: '/api/affiliate/webhooks/testnet',
      headers: {
        'content-type': 'application/json',
        'x-workspace-id': workspaceId,
        'x-affiliate-timestamp': timestamp,
        'x-affiliate-signature': signature,
      },
      payload: raw,
    });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.json().conversion).toMatchObject({ amountCents: 4321, commissionCents: 321, status: 'pending' });
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);
    const rows = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) =>
      tx.affiliateConversion.findMany({ where: { workspaceId, externalEventId: payload.externalEventId } }));
    expect(rows).toHaveLength(1);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/affiliate/webhooks/testnet',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-affiliate-timestamp': timestamp, 'x-affiliate-signature': '0'.repeat(64) },
      payload: raw,
    });
    expect(bad.statusCode).toBe(401);
  });

  it('revoking an approval blocks enqueue and persists payout reference and timestamp', async () => {
    const { workspaceId, headers } = await workspace();
    const approvalPayload = {
      platform: 'youtube', entityType: 'clip', entityId: `clip-${randomUUID()}`,
      idempotencyKey: `idem-${randomUUID()}`,
    };
    const created = await app.inject({ method: 'POST', url: '/api/publishing/approvals', headers, payload: approvalPayload });
    expect(created.statusCode).toBe(201);
    const approvalId = created.json().approval.id;
    const revoked = await app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/revoke`, headers, payload: {} });
    expect(revoked.statusCode).toBe(200);
    const enqueued = await app.inject({
      method: 'POST', url: '/api/publishing/jobs', headers,
      payload: { ...approvalPayload, approvalId },
    });
    expect(enqueued.statusCode).toBe(409);
    expect(enqueued.json().error.code).toBe('APPROVAL_REQUIRED');

    const conversion = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers,
      payload: { amountCents: 1000, commissionCents: 100, currency: 'EUR' },
    });
    expect(conversion.statusCode).toBe(201);
    const id = conversion.json().conversion.id;
    for (const action of ['approve', 'pay']) {
      const res = await app.inject({
        method: 'POST', url: `/api/affiliate/conversions/${id}/payout`, headers,
        payload: { action, reference: action === 'pay' ? 'payout-ref-1' : undefined },
      });
      expect(res.statusCode).toBe(200);
    }
    const row: any = await withWorkspaceTransaction(workspaceId, (tx: any) =>
      tx.affiliateConversion.findFirst({ where: { id, workspaceId } }));
    expect(row.status).toBe('paid');
    expect(row.payoutReference).toBe('payout-ref-1');
    expect(row.paidAt).not.toBeNull();
  });
});
