import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';

describe('cross-platform', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('creates post and snapshot', async () => {
    const email = `cp-${Date.now()}@x.com`;
    const slug = `cp-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'CP', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const p = await app.inject({ method: 'POST', url: '/api/content-posts', headers: { cookie, 'x-workspace-id': ws }, payload: { platform: 'youtube', externalId: `yt-${Date.now()}`, title: 'Video' } });
    expect(p.statusCode).toBe(201);
    const snap = await app.inject({ method: 'POST', url: `/api/content-posts/${p.json().post.id}/snapshots`, headers: { cookie, 'x-workspace-id': ws }, payload: { views: 100, likes: 5 } });
    expect(snap.statusCode).toBe(201);
  });
});
