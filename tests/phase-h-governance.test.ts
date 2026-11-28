import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { phaseHAgentContext } from '../src/phase-h-agent-context.js';
import { retentionReport } from '../src/data-governance.js';

const workspaceIds: string[] = [];
let app: any;

afterAll(async () => {
  if (app) await app.close();
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

async function workspace() {
  const suffix = randomUUID();
  const email = `h5gov-${suffix}@x.com`;
  const signup = await app.inject({
    method: 'POST', url: '/api/auth/signup',
    payload: { email, password: 'password1234', workspaceName: 'H5 governance', workspaceSlug: `h5gov-${suffix}` },
  });
  expect(signup.statusCode).toBe(201);
  const workspaceId = signup.json().workspace.id;
  workspaceIds.push(workspaceId);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
  return { workspaceId, headers: { cookie: login.headers['set-cookie'], 'x-workspace-id': workspaceId } };
}

describe('Phase H agent backend wiring', () => {
  it('derives department numbers from persisted workspace rows', async () => {
    app = await buildServer();
    const { workspaceId, headers } = await workspace();
    await app.inject({
      method: 'POST', url: '/api/publishing/accounts', headers,
      payload: { platform: 'youtube', accountKey: 'yt-main', displayName: 'Main' },
    });
    await app.inject({
      method: 'POST', url: '/api/affiliate/links', headers,
      payload: { token: 'link-1', offerId: 'offer-1', destinationUrl: 'https://example.test/product' },
    });
    const publishing: any = await phaseHAgentContext(workspaceId, 'publishing');
    expect(publishing.contextSource).toBe('workspace_rows');
    expect(publishing.publishingAccounts).toBe(1);
    const affiliate: any = await phaseHAgentContext(workspaceId, 'growth');
    expect(affiliate.affiliateLinks).toBe(1);
    const ceo: any = await phaseHAgentContext(workspaceId, 'ceo');
    expect(ceo.contextSource).toBe('workspace_rows');
    const unknown: any = await phaseHAgentContext(workspaceId, 'unknown-department');
    expect(unknown.externalLiveVerified).toBe(false);
  });
});

describe('Phase H local data governance', () => {
  it('records consent, reports retention and requires explicit purge confirmation', async () => {
    const { workspaceId, headers } = await workspace();
    const consent = await app.inject({
      method: 'POST', url: '/api/privacy/consent', headers,
      payload: { subjectId: 'visitor-1', purpose: 'affiliate_attribution', granted: true },
    });
    expect(consent.statusCode).toBe(200);
    const report = await retentionReport(workspaceId);
    expect(report).toMatchObject({ clicks: 0, conversions: 0, legalComplianceClaimed: false });
    expect(report.missing).toBe('NO_ROWS');

    const unconfirmed = await app.inject({
      method: 'POST', url: '/api/privacy/purge', headers,
      payload: { olderThanDays: 30, confirm: false },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe('CONFIRM_REQUIRED');
    const badPeriod = await app.inject({
      method: 'POST', url: '/api/privacy/purge', headers,
      payload: { olderThanDays: 1, confirm: true },
    });
    expect(badPeriod.statusCode).toBe(400);
    const purge = await app.inject({
      method: 'POST', url: '/api/privacy/purge', headers,
      payload: { olderThanDays: 30, confirm: true },
    });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().purge).toMatchObject({ deletedClicks: 0, deletedConversions: 0 });
    const audit: any = await withWorkspaceTransaction<any[]>(workspaceId, (tx: any) =>
      tx.auditEvent.findMany({ where: { workspaceId, type: { in: ['data_consent_granted', 'affiliate_retention_purge'] } } }));
    expect(audit).toHaveLength(2);
  });
});
