import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';

describe('workspace isolation', () => {
  let app: any;
  let tokenA: string;
  let tokenB: string;
  let workspaceA: string;
  let workspaceB: string;
  const itemTitle = `item-${Date.now()}`;

  beforeAll(async () => {
    app = await buildServer();
    const emailA = `iso-a-${Date.now()}@x.com`;
    const slugA = `iso-a-${Date.now()}`;
    const resA = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailA, password: 'password1234', workspaceName: 'WSA', workspaceSlug: slugA } });
    workspaceA = resA.json().workspace.id;
    const loginA = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailA, password: 'password1234' } });
    tokenA = loginA.headers['set-cookie'];

    const emailB = `iso-b-${Date.now()}@x.com`;
    const slugB = `iso-b-${Date.now()}`;
    const resB = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailB, password: 'password1234', workspaceName: 'WSB', workspaceSlug: slugB } });
    workspaceB = resB.json().workspace.id;
    const loginB = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: emailB, password: 'password1234' } });
    tokenB = loginB.headers['set-cookie'];

    await app.inject({ method: 'POST', url: '/api/items', headers: { cookie: tokenA, 'x-workspace-id': workspaceA }, payload: { title: itemTitle } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('owner can read own item', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: tokenA, 'x-workspace-id': workspaceA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((i: any) => i.title === itemTitle)).toBe(true);
  });

  it('non-member gets 403 for foreign workspace', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: tokenB, 'x-workspace-id': workspaceA } });
    expect(res.statusCode).toBe(403);
  });

  it('member of other workspace sees no foreign items', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: tokenB, 'x-workspace-id': workspaceB } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.some((i: any) => i.title === itemTitle)).toBe(false);
  });

  it('invalid workspace id rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items', headers: { cookie: tokenA, 'x-workspace-id': 'bad id' } });
    expect(res.statusCode).toBe(400);
  });

  it('RLS blocks direct query under wrong workspace context', async () => {
    const rows = await withWorkspaceTransaction(workspaceB, async (tx) => {
      return tx.item.findMany({ where: { title: itemTitle } });
    });
    expect(rows.length).toBe(0);
  });
});
