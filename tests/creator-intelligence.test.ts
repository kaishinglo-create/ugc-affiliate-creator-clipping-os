import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma } from '../lib/db.js';
import { contentOpportunityScore } from '../src/scoring.js';

describe('creator intelligence', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  it('scoring returns 0-100 with explanation', () => {
    const r = contentOpportunityScore({ demand: 80, competition: 20, relevance: 70, effort: 30, dataQuality: 60 });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.explanation).toContain('Score');
  });

  it('creates niche, product, idea', async () => {
    const email = `ci-${Date.now()}@x.com`;
    const slug = `ci-${Date.now()}`;
    const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'CI', workspaceSlug: slug } });
    const ws = r.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const n = await app.inject({ method: 'POST', url: '/api/niches', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Tech', demandScore: 80, competition: 20 } });
    expect(n.statusCode).toBe(201);
    const nicheId = n.json().niche.id;
    const p = await app.inject({ method: 'POST', url: '/api/products', headers: { cookie, 'x-workspace-id': ws }, payload: { name: 'Gadget', nicheId } });
    expect(p.statusCode).toBe(201);
    const i = await app.inject({ method: 'POST', url: '/api/ideas', headers: { cookie, 'x-workspace-id': ws }, payload: { title: 'Review video', nicheId, demand: 80, competition: 20, relevance: 70, effort: 30, dataQuality: 60 } });
    expect(i.statusCode).toBe(201);
    expect(i.json().idea.score).toBeGreaterThanOrEqual(0);
  });
});
