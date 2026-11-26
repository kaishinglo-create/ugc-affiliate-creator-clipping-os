import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import { resolvePayoutTransition, summarizeAttribution, summarizePayouts } from '../src/affiliate.js';

describe('affiliate attribution and payouts', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  async function workspace(label: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${label}-${stamp}@x.com`;
    const slug = `${label}-${stamp}`;
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: label, workspaceSlug: slug } });
    const ws = signup.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    return { ws, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': ws } };
  }

  it('derives click attribution and enforces the payout state machine', async () => {
    const { headers } = await workspace('aff');
    const click = await app.inject({
      method: 'POST', url: '/api/analytics/clicks', headers,
      payload: { contentId: 'content-1', offerId: 'offer-1', idempotencyKey: `click-${Date.now()}` },
    });
    expect(click.statusCode).toBe(201);

    const conversionKey = `conv-${Date.now()}`;
    const conversion = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers,
      payload: { clickId: click.json().click.id, amountCents: 5000, idempotencyKey: conversionKey },
    });
    expect(conversion.statusCode).toBe(201);
    expect(conversion.json().conversion.status).toBe('pending');
    expect(conversion.json().attribution).toEqual({
      clickId: click.json().click.id,
      contentId: 'content-1',
      offerId: 'offer-1',
      attributed: true,
    });

    const duplicate = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers,
      payload: { clickId: click.json().click.id, amountCents: 9999, idempotencyKey: conversionKey },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    expect(duplicate.json().conversion.id).toBe(conversion.json().conversion.id);
    expect(duplicate.json().conversion.amountCents).toBe(5000);

    const invalidClick = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers,
      payload: { clickId: 'does-not-exist', amountCents: 100 },
    });
    expect(invalidClick.statusCode).toBe(400);
    expect(invalidClick.json().error).toBe('INVALID_CLICK_ID');

    const unattributed = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers,
      payload: { amountCents: 1000 },
    });
    expect(unattributed.statusCode).toBe(201);
    expect(unattributed.json().attribution.attributed).toBe(false);

    const attribution = await app.inject({ method: 'GET', url: '/api/affiliate/attribution', headers });
    expect(attribution.statusCode).toBe(200);
    const summary = attribution.json().attribution;
    expect(summary.clicks).toBe(1);
    expect(summary.conversions).toBe(2);
    expect(summary.attributedConversions).toBe(1);
    expect(summary.unattributedConversions).toBe(1);
    expect(summary.unresolvedClickIds).toBe(0);
    expect(summary.conversionRate).toBe(2);
    expect(summary.pendingCents).toBe(6000);
    expect(summary.revenueCents).toBe(0);
    expect(summary.byContent).toEqual([expect.objectContaining({ contentId: 'content-1', clicks: 1, conversions: 1, pendingCents: 5000 })]);
    expect(summary.byOffer).toEqual([expect.objectContaining({ offerId: 'offer-1', clicks: 1, conversions: 1, pendingCents: 5000 })]);

    const beforePayout = await app.inject({ method: 'GET', url: '/api/affiliate/payouts', headers });
    expect(beforePayout.statusCode).toBe(200);
    expect(beforePayout.json().totals.pending).toEqual({ count: 2, amountCents: 6000 });
    expect(beforePayout.json().totals.payableCents).toBe(0);
    expect(beforePayout.json().totals.unpaidCents).toBe(6000);

    const conversionId = conversion.json().conversion.id;
    const approved = await app.inject({
      method: 'POST', url: `/api/affiliate/conversions/${conversionId}/payout`, headers,
      payload: { action: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().conversion.status).toBe('approved');

    const afterApproval = await app.inject({ method: 'GET', url: '/api/affiliate/payouts', headers });
    expect(afterApproval.json().totals.payableCents).toBe(5000);
    expect(afterApproval.json().totals.unpaidCents).toBe(6000);

    const paid = await app.inject({
      method: 'POST', url: `/api/affiliate/conversions/${conversionId}/payout`, headers,
      payload: { action: 'pay', reference: 'MANUAL-001' },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().conversion.status).toBe('paid');

    const repeatedPayment = await app.inject({
      method: 'POST', url: `/api/affiliate/conversions/${conversionId}/payout`, headers,
      payload: { action: 'pay' },
    });
    expect(repeatedPayment.statusCode).toBe(409);
    expect(repeatedPayment.json().error).toBe('INVALID_PAYOUT_TRANSITION');

    const rejected = await app.inject({
      method: 'POST', url: `/api/affiliate/conversions/${unattributed.json().conversion.id}/payout`, headers,
      payload: { action: 'reject' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().conversion.status).toBe('rejected');

    const finalAttribution = await app.inject({ method: 'GET', url: '/api/affiliate/attribution', headers });
    const finalSummary = finalAttribution.json().attribution;
    expect(finalSummary.revenueCents).toBe(5000);
    expect(finalSummary.paidCents).toBe(5000);
    expect(finalSummary.pendingCents).toBe(0);
    expect(finalSummary.rejectedCents).toBe(1000);

    const finalPayouts = await app.inject({ method: 'GET', url: '/api/affiliate/payouts', headers });
    expect(finalPayouts.json().totals.paid).toEqual({ count: 1, amountCents: 5000 });
    expect(finalPayouts.json().totals.rejected).toEqual({ count: 1, amountCents: 1000 });
    expect(finalPayouts.json().totals.unpaidCents).toBe(0);
  });

  it('refuses to attribute a click from another workspace', async () => {
    const first = await workspace('aff-a');
    const second = await workspace('aff-b');
    const foreignClick = await app.inject({
      method: 'POST', url: '/api/analytics/clicks', headers: first.headers,
      payload: { contentId: 'foreign-content' },
    });
    expect(foreignClick.statusCode).toBe(201);

    const conversion = await app.inject({
      method: 'POST', url: '/api/affiliate/conversions', headers: second.headers,
      payload: { clickId: foreignClick.json().click.id, amountCents: 2500 },
    });
    expect(conversion.statusCode).toBe(400);
    expect(conversion.json().error).toBe('INVALID_CLICK_ID');
  });
});

describe('affiliate helper invariants', () => {
  it('only allows pending→approved→paid or reject before payment', () => {
    expect(resolvePayoutTransition('pending', 'approve')).toEqual({ ok: true, status: 'approved' });
    expect(resolvePayoutTransition('approved', 'pay')).toEqual({ ok: true, status: 'paid' });
    expect(resolvePayoutTransition('pending', 'reject')).toEqual({ ok: true, status: 'rejected' });
    expect(resolvePayoutTransition('approved', 'reject')).toEqual({ ok: true, status: 'rejected' });
    expect(resolvePayoutTransition('pending', 'pay').ok).toBe(false);
    expect(resolvePayoutTransition('paid', 'pay').ok).toBe(false);
    expect(resolvePayoutTransition('rejected', 'approve').ok).toBe(false);
  });

  it('keeps unattributed and unresolved conversions out of click attribution', () => {
    const summary = summarizeAttribution(
      [{ id: 'click-1', contentId: 'content-1', offerId: null, clickedAt: new Date() }],
      [
        { id: 'conv-1', clickId: 'click-1', amountCents: 1200, status: 'approved', convertedAt: new Date() },
        { id: 'conv-2', clickId: null, amountCents: 300, status: 'pending', convertedAt: new Date() },
        { id: 'conv-3', clickId: 'missing', amountCents: 400, status: 'rejected', convertedAt: new Date() },
      ],
    );
    expect(summary.attributedConversions).toBe(1);
    expect(summary.unattributedConversions).toBe(2);
    expect(summary.unresolvedClickIds).toBe(1);
    expect(summary.revenueCents).toBe(1200);
    expect(summary.byContent).toEqual([expect.objectContaining({ contentId: 'content-1', clicks: 1, conversions: 1, approvedCents: 1200 })]);
    expect(summarizePayouts([{ id: 'conv-1', clickId: null, amountCents: 1200, status: 'approved', convertedAt: new Date() }]).payableCents).toBe(1200);
  });
});
