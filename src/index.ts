import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { hashPassword, verifyPassword, createSession, verifySession, sessionCookieHeader, readSessionCookie, revokeSession } from '../lib/auth.js';

const app = Fastify({ logger: true });

const allowedOrigin = process.env.CORS_ORIGIN?.trim() || 'http://localhost:5173';
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

export async function buildServer() {
  await app.ready();
  return app;
}

process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
process.on('SIGINT', async () => { await app.close(); process.exit(0); });

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
