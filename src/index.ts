import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { hashPassword, verifyPassword, createSession, verifySession, sessionCookieHeader, readSessionCookie, revokeSession } from '../lib/auth.js';

const app = Fastify({ logger: true });

const config = loadConfig();
const allowedOrigin = config.corsOrigin;
app.register(helmet, { contentSecurityPolicy: false });
app.register(cors, { origin: allowedOrigin, credentials: true });
app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

app.setErrorHandler((err, req, reply) => {
  const status = (err as any).statusCode ?? 500;
  const message = status >= 500 ? 'INTERNAL_ERROR' : (err as Error).message;
  req.log.error(err);
  reply.code(status).send({ error: message });
});

app.get('/health', async () => ({ status: 'ok' }));

app.get('/ready', async (req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ready' };
  } catch (e) {
    req.log.error(e);
    return reply.code(503).send({ status: 'not_ready' });
  }
});

const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(120).optional(),
  workspaceName: z.string().trim().min(1).max(120),
  workspaceSlug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/),
});

app.post('/api/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const input = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) return reply.code(409).send({ error: 'EMAIL_ALREADY_REGISTERED' });
  const existingWs = await prisma.workspace.findUnique({ where: { slug: input.workspaceSlug } });
  if (existingWs) return reply.code(409).send({ error: 'WORKSPACE_SLUG_TAKEN' });

  const passwordHash = await hashPassword(input.password);
  const { user, workspace } = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { email: input.email, passwordHash, name: input.name } });
    const w = await tx.workspace.create({ data: { name: input.workspaceName, slug: input.workspaceSlug } });
    await tx.membership.create({ data: { userId: u.id, workspaceId: w.id, role: 'OWNER' } });
    return { user: u, workspace: w };
  });
  const { jwt, expiresAt } = await createSession(user.id);
  reply.header('set-cookie', sessionCookieHeader(jwt, expiresAt));
  reply.code(201).send({ user: { id: user.id, email: user.email, name: user.name }, workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug } });
  return;
});

const LoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const input = parsed.data;
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = user ? await verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !ok) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
  const { jwt, expiresAt } = await createSession(user.id);
  reply.header('set-cookie', sessionCookieHeader(jwt, expiresAt));
  return { user: { id: user.id, email: user.email, name: user.name } };
});

app.post('/api/auth/logout', async (req, reply) => {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (session) await revokeSession(session.sessionId);
  reply.header('set-cookie', 'ugc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  return { ok: true };
});

app.get('/api/auth/me', async (req, reply) => {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { memberships: { include: { workspace: true } } },
  });
  if (!user) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });
  return { user: { id: user.id, email: user.email, name: user.name }, workspaces: user.memberships.map((m) => ({ ...m.workspace, role: m.role })) };
});

async function requireAuthWorkspace(req: any, reply: any) {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) { reply.code(401).send({ error: 'NOT_AUTHENTICATED' }); return null; }
  const workspaceId = (req.headers['x-workspace-id'] as string) || (req.query as any)?.workspaceId;
  if (!workspaceId) { reply.code(400).send({ error: 'WORKSPACE_ID_REQUIRED' }); return null; }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) { reply.code(400).send({ error: 'INVALID_WORKSPACE_ID' }); return null; }
  const membership = await prisma.membership.findUnique({ where: { userId_workspaceId: { userId: session.userId, workspaceId } } });
  if (!membership) { reply.code(403).send({ error: 'NOT_A_WORKSPACE_MEMBER' }); return null; }
  return { userId: session.userId, workspaceId, role: membership.role };
}

app.post('/api/items', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const title = String(body.title ?? '').trim();
  if (!title || title.length > 200) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const item = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.item.create({ data: { workspaceId: ctx.workspaceId, title } }));
  reply.code(201).send({ item });
  return;
});

app.get('/api/items', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const q = (req.query ?? {}) as any;
  const take = Math.min(Number(q.limit ?? 50), 100);
  const skip = Number(q.offset ?? 0);
  const items = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.item.findMany({ where: { workspaceId: ctx.workspaceId }, take, skip, orderBy: { createdAt: 'desc' } }));
  return { items, limit: take, offset: skip };
});


// Niches
app.get('/api/niches', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const niches = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.niche.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } }));
  return { niches };
});

app.post('/api/niches', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const niche = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.niche.create({ data: { workspaceId: ctx.workspaceId, name, description: body.description ?? null, demandScore: Number(body.demandScore ?? 0), competition: Number(body.competition ?? 0) } }));
  reply.code(201).send({ niche });
  return;
});

// Products
app.get('/api/products', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const products = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.product.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } }));
  return { products };
});

app.post('/api/products', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const product = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.product.create({ data: { workspaceId: ctx.workspaceId, nicheId: body.nicheId ?? null, name, category: body.category ?? null, priceCents: body.priceCents ?? null, source: body.source ?? null, sourceUrl: body.sourceUrl ?? null } }));
  reply.code(201).send({ product });
  return;
});

// Content ideas
app.get('/api/ideas', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const ideas = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.contentIdea.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } }));
  return { ideas };
});

app.post('/api/ideas', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const title = String(body.title ?? '').trim();
  if (!title) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const { contentOpportunityScore } = await import('./scoring.js');
  const input = { demand: Number(body.demand ?? 50), competition: Number(body.competition ?? 50), relevance: Number(body.relevance ?? 50), effort: Number(body.effort ?? 50), dataQuality: Number(body.dataQuality ?? 50) };
  const { score, explanation } = contentOpportunityScore(input);
  const idea = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.contentIdea.create({ data: { workspaceId: ctx.workspaceId, nicheId: body.nicheId ?? null, productId: body.productId ?? null, title, hook: body.hook ?? null, format: body.format ?? null, targetAudience: body.targetAudience ?? null, cta: body.cta ?? null, keywords: body.keywords ?? null, score } }));
  reply.code(201).send({ idea, scoreExplanation: explanation });
  return;
});


// Integrations
app.get('/api/integrations', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const { PROVIDERS, providerStatus } = await import('./integrations.js');
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.integration.findMany({ where: { workspaceId: ctx.workspaceId } })) as any;
  const byProvider = Object.fromEntries(rows.map((r: any) => [r.provider, r]));
  const list = PROVIDERS.map((p) => ({
    ...p,
    status: byProvider[p.provider]?.status ?? providerStatus(p.provider),
    lastError: byProvider[p.provider]?.lastError ?? null,
  }));
  return { integrations: list };
});

app.post('/api/integrations/:provider', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const provider = (req.params as any).provider;
  const valid = ['yaps','clippingmini','klap','opusclip'];
  if (!valid.includes(provider)) return reply.code(400).send({ error: 'UNKNOWN_PROVIDER' });
  const body = (req.body ?? {}) as any;
  const configured = Boolean(body.apiKey);
  // Never store raw keys in DB; store only status + masked hint
  const status = configured ? 'CONFIGURED' : 'NOT_CONFIGURED';
  const row = await withWorkspaceTransaction(ctx.workspaceId, (tx) => tx.integration.upsert({
    where: { workspaceId_provider: { workspaceId: ctx.workspaceId, provider } },
    create: { workspaceId: ctx.workspaceId, provider, status: status as any, config: configured ? { hint: '***' } : null },
    update: { status: status as any, config: configured ? { hint: '***' } : null, lastError: null },
  }));
  reply.code(200).send({ integration: row });
  return;
});


// Workflows
app.get('/api/workflows', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const { } = await import('./workflows.js');
  const defs = await (await import('../lib/db.js')).withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.workflowDefinition.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } }));
  return { workflows: defs };
});

app.post('/api/workflows', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const { createDefinition } = await import('./workflows.js');
  const def = await createDefinition(ctx.workspaceId, name, steps);
  reply.code(201).send({ workflow: def });
  return;
});

app.post('/api/workflows/:id/run', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const id = (req.params as any).id;
  const body = (req.body ?? {}) as any;
  const { startRun, executeRun } = await import('./workflows.js');
  const run = await startRun(ctx.workspaceId, id, body.input ?? null, body.idempotencyKey);
  const executed = await executeRun(ctx.workspaceId, run.id);
  return { run: executed };
});

app.get('/api/workflow-runs/:id', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const id = (req.params as any).id;
  const { withWorkspaceTransaction } = await import('../lib/db.js');
  const run = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.workflowRun.findUnique({ where: { id }, include: { steps: true } }));
  if (!run) return reply.code(404).send({ error: 'NOT_FOUND' });
  return { run };
});


// Analytics
app.post('/api/analytics/snapshots', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const metric = String(body.metric ?? '').trim();
  const value = Number(body.value);
  if (!metric || !Number.isFinite(value)) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const now = new Date();
  const snap = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.analyticsSnapshot.create({ data: { workspaceId: ctx.workspaceId, source: body.source ?? 'manual', metric, value, periodStart: body.periodStart ? new Date(body.periodStart) : now, periodEnd: body.periodEnd ? new Date(body.periodEnd) : now } }));
  reply.code(201).send({ snapshot: snap });
  return;
});

app.get('/api/analytics/summary', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const snaps = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.analyticsSnapshot.findMany({ where: { workspaceId: ctx.workspaceId } })) as any;
  const byMetric: Record<string, number> = {};
  for (const s of snaps) { byMetric[s.metric] = (byMetric[s.metric] ?? 0) + s.value; }
  const clicks = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.affiliateClick.count({ where: { workspaceId: ctx.workspaceId } }));
  const convs = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.affiliateConversion.count({ where: { workspaceId: ctx.workspaceId } }));
  return { summary: { metrics: byMetric, clicks, conversions: convs, dataAvailable: snaps.length > 0 } };
});

app.post('/api/analytics/clicks', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const key = body.idempotencyKey ? String(body.idempotencyKey) : undefined;
  if (key) {
    const existing = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.affiliateClick.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: ctx.workspaceId, idempotencyKey: key } } }));
    if (existing) { reply.code(200).send({ click: existing, duplicate: true }); return; }
  }
  const click = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.affiliateClick.create({ data: { workspaceId: ctx.workspaceId, contentId: body.contentId ?? null, offerId: body.offerId ?? null, idempotencyKey: key ?? null } }));
  reply.code(201).send({ click });
  return;
});


// Business Hub
app.get('/api/creators', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.creator.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { creators: rows };
});
app.post('/api/creators', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const c = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.creator.create({ data: { workspaceId: ctx.workspaceId, name, email: body.email ?? null, niches: body.niches ?? null, platforms: body.platforms ?? null } }));
  reply.code(201).send({ creator: c }); return;
});

app.get('/api/brands', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.brand.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { brands: rows };
});
app.post('/api/brands', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const b = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.brand.create({ data: { workspaceId: ctx.workspaceId, name, guidelines: body.guidelines ?? null, tone: body.tone ?? null } }));
  reply.code(201).send({ brand: b }); return;
});

app.get('/api/campaigns', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.campaign.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { campaigns: rows };
});
app.post('/api/campaigns', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const c = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.campaign.create({ data: { workspaceId: ctx.workspaceId, brandId: body.brandId ?? null, name, goal: body.goal ?? null, budgetCents: body.budgetCents ?? null, status: body.status ?? 'draft' } }));
  reply.code(201).send({ campaign: c }); return;
});

app.get('/api/tasks', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.task.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { tasks: rows };
});
app.post('/api/tasks', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const title = String(body.title ?? '').trim();
  if (!title) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const t = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.task.create({ data: { workspaceId: ctx.workspaceId, campaignId: body.campaignId ?? null, title, description: body.description ?? null, assignee: body.assignee ?? null, priority: body.priority ?? 'medium', status: body.status ?? 'open', dueDate: body.dueDate ? new Date(body.dueDate) : null } }));
  reply.code(201).send({ task: t }); return;
});

app.get('/api/assets', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.assetVersion.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { assets: rows };
});


// Growth Engine
app.get('/api/experiments', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.experiment.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { experiments: rows };
});
app.post('/api/experiments', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const e = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.experiment.create({ data: { workspaceId: ctx.workspaceId, name, hypothesis: body.hypothesis ?? null, metric: body.metric ?? null, status: body.status ?? 'draft' } }));
  reply.code(201).send({ experiment: e }); return;
});

app.get('/api/insights', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.insight.findMany({ where: { workspaceId: ctx.workspaceId, active: true }, orderBy: { createdAt: 'desc' } })) as any;
  return { insights: rows };
});
app.post('/api/insights', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const title = String(body.title ?? '').trim();
  const insightBody = String(body.body ?? '').trim();
  if (!title || !insightBody) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const i = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.insight.create({ data: { workspaceId: ctx.workspaceId, title, body: insightBody, source: body.source ?? null, confidence: Number(body.confidence ?? 0) } }));
  reply.code(201).send({ insight: i }); return;
});


app.get('/api/system/status', async (req, reply) => {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });
  let dbOk = false;
  try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch {}
  return { status: dbOk ? 'ok' : 'degraded', db: dbOk, version: '0.1.0', time: new Date().toISOString() };
});


// Autonomous orchestrator
app.get('/api/approvals', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.approval.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { approvals: rows };
});
app.post('/api/approvals', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const entityType = String(body.entityType ?? '').trim();
  const entityId = String(body.entityId ?? '').trim();
  if (!entityType || !entityId) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const a = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.approval.create({ data: { workspaceId: ctx.workspaceId, entityType, entityId, requestedBy: ctx.userId } }));
  reply.code(201).send({ approval: a }); return;
});
app.post('/api/approvals/:id/decide', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const id = (req.params as any).id;
  const body = (req.body ?? {}) as any;
  const status = body.status === 'approved' ? 'approved' : body.status === 'rejected' ? 'rejected' : null;
  if (!status) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const a = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.approval.update({ where: { id }, data: { status, decidedBy: ctx.userId, decidedAt: new Date(), reason: body.reason ?? null } }));
  return { approval: a };
});

app.get('/api/orchestrator/summary', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const [workflows, runs, pendingApprovals, ideas, insights] = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => Promise.all([
    tx.workflowDefinition.count({ where: { workspaceId: ctx.workspaceId } }),
    tx.workflowRun.count({ where: { workspaceId: ctx.workspaceId } }),
    tx.approval.count({ where: { workspaceId: ctx.workspaceId, status: 'pending' } }),
    tx.contentIdea.count({ where: { workspaceId: ctx.workspaceId } }),
    tx.insight.count({ where: { workspaceId: ctx.workspaceId, active: true } }),
  ]));
  return { summary: { workflows, runs, pendingApprovals, ideas, insights } };
});


// Security
app.get('/api/security/kill-switch', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const { isKillSwitchActive } = await import('../lib/security.js');
  const active = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => isKillSwitchActive(ctx.workspaceId, tx));
  return { active };
});

app.post('/api/security/kill-switch/activate', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const reason = String(body.reason ?? 'manual').slice(0, 500);
  const { activateKillSwitch, logSecurityEvent } = await import('../lib/security.js');
  await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => activateKillSwitch(ctx.workspaceId, reason, ctx.userId, tx));
  await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => logSecurityEvent(ctx.workspaceId, 'kill_switch_activated', 'success', tx, reason, ctx.userId));
  return { active: true };
});

app.post('/api/security/kill-switch/deactivate', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const { deactivateKillSwitch, logSecurityEvent } = await import('../lib/security.js');
  await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => deactivateKillSwitch(ctx.workspaceId, tx));
  await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => logSecurityEvent(ctx.workspaceId, 'kill_switch_deactivated', 'success', tx, undefined, ctx.userId));
  return { active: false };
});

app.get('/api/security/events', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.securityEvent.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' }, take: 50 })) as any;
  return { events: rows };
});


// Reliability
app.get('/api/incidents', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.incident.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { incidents: rows };
});
app.post('/api/incidents', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const title = String(body.title ?? '').trim();
  if (!title) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const inc = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.incident.create({ data: { workspaceId: ctx.workspaceId, title, severity: body.severity ?? 'medium', status: 'open', signature: body.signature ?? null, details: body.details ?? null } }));
  reply.code(201).send({ incident: inc }); return;
});
app.post('/api/incidents/:id/resolve', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const id = (req.params as any).id;
  const body = (req.body ?? {}) as any;
  const inc = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.incident.update({ where: { id }, data: { status: 'resolved', resolvedAt: new Date(), details: body.details ?? undefined } }));
  return { incident: inc };
});


// Multi-agent
app.get('/api/agents', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentDefinition.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { agents: rows };
});
app.post('/api/agents', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  const role = String(body.role ?? '').trim();
  if (!name || !role) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const a = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentDefinition.create({ data: { workspaceId: ctx.workspaceId, name, role, capabilities: body.capabilities ?? {}, enabled: body.enabled !== false } }));
  reply.code(201).send({ agent: a }); return;
});

app.get('/api/agent-tasks', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentTask.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { tasks: rows };
});
app.post('/api/agent-tasks', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const name = String(body.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const t = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentTask.create({ data: { workspaceId: ctx.workspaceId, agentId: body.agentId ?? null, name, status: 'queued', input: body.input ?? null } }));
  reply.code(201).send({ task: t }); return;
});
app.post('/api/agent-tasks/:id/run', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const id = (req.params as any).id;
  const task = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentTask.findUnique({ where: { id } })) as any;
  if (!task) return reply.code(404).send({ error: 'NOT_FOUND' });
  await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentTask.update({ where: { id }, data: { status: 'running', startedAt: new Date() } }));
  // simple execution: echo input
  const output = { echoed: task.input, agent: task.agentId };
  await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentTask.update({ where: { id }, data: { status: 'completed', output, finishedAt: new Date() } }));
  const updated = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.agentTask.findUnique({ where: { id } }));
  return { task: updated };
});


// Cross-platform content intelligence
app.get('/api/content-posts', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const rows = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.contentPost.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'desc' } })) as any;
  return { posts: rows };
});
app.post('/api/content-posts', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const platform = String(body.platform ?? '').trim();
  const externalId = String(body.externalId ?? '').trim();
  if (!platform || !externalId) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const p = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.contentPost.create({ data: { workspaceId: ctx.workspaceId, platform, externalId, title: body.title ?? null, url: body.url ?? null, format: body.format ?? null, publishedAt: body.publishedAt ? new Date(body.publishedAt) : null } }));
  reply.code(201).send({ post: p }); return;
});
app.post('/api/content-posts/:id/snapshots', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const id = (req.params as any).id;
  const body = (req.body ?? {}) as any;
  const post = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.contentPost.findUnique({ where: { id } })) as any;
  if (!post || post.workspaceId !== ctx.workspaceId) return reply.code(404).send({ error: 'NOT_FOUND' });
  const snap = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.performanceSnapshot.create({ data: { workspaceId: ctx.workspaceId, postId: id, views: Number(body.views ?? 0), likes: Number(body.likes ?? 0), comments: Number(body.comments ?? 0), shares: Number(body.shares ?? 0), watchTimeSec: body.watchTimeSec ?? null } }));
  reply.code(201).send({ snapshot: snap }); return;
});


// Operations control
app.get('/api/operations/summary', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const [workflows, runs, pendingApprovals, incidents, ideas] = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => Promise.all([
    tx.workflowDefinition.count({ where: { workspaceId: ctx.workspaceId } }),
    tx.workflowRun.count({ where: { workspaceId: ctx.workspaceId } }),
    tx.approval.count({ where: { workspaceId: ctx.workspaceId, status: 'pending' } }),
    tx.incident.count({ where: { workspaceId: ctx.workspaceId, status: 'open' } }),
    tx.contentIdea.count({ where: { workspaceId: ctx.workspaceId } }),
  ]));
  return { summary: { workflows, runs, pendingApprovals, incidents, ideas } };
});

app.post('/api/policies', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const key = String(body.key ?? '').trim();
  if (!key) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const p = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.operationalPolicy.upsert({
    where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } },
    create: { workspaceId: ctx.workspaceId, key, value: body.value ?? {} },
    update: { value: body.value ?? {} },
  }));
  reply.code(201).send({ policy: p }); return;
});

app.post('/api/lifecycle-events', async (req, reply) => {
  const ctx = await requireAuthWorkspace(req, reply);
  if (!ctx) return;
  const body = (req.body ?? {}) as any;
  const entityType = String(body.entityType ?? '').trim();
  const entityId = String(body.entityId ?? '').trim();
  const toStatus = String(body.toStatus ?? '').trim();
  if (!entityType || !entityId || !toStatus) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const e = await withWorkspaceTransaction(ctx.workspaceId, (tx: any) => tx.contentLifecycleEvent.create({ data: { workspaceId: ctx.workspaceId, entityType, entityId, fromStatus: body.fromStatus ?? null, toStatus, actor: ctx.userId } }));
  reply.code(201).send({ event: e }); return;
});

export async function buildServer() {
  await app.ready();
  return app;
}

process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
process.on('SIGINT', async () => { await app.close(); process.exit(0); });

async function main() {
  const port = config.port;
  await app.listen({ port, host: '0.0.0.0' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
