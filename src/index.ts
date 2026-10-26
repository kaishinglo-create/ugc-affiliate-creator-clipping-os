import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { hashPassword, verifyPassword, createSession, verifySession, sessionCookieHeader, readSessionCookie } from '../lib/auth.js';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

const SignupSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(120).optional(),
  workspaceName: z.string().trim().min(1).max(120),
  workspaceSlug: z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/),
});

app.post('/api/auth/signup', async (req, reply) => {
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

const LoginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) });

app.post('/api/auth/login', async (req, reply) => {
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

const WorkspaceIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ItemCreateSchema = z.object({ title: z.string().trim().min(1).max(200) });

app.post('/api/items', async (req, reply) => {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });
  const workspaceParsed = WorkspaceIdSchema.safeParse((req.headers['x-workspace-id'] as string) || (req.query as any)?.workspaceId);
  if (!workspaceParsed.success) return reply.code(400).send({ error: 'INVALID_WORKSPACE_ID' });
  const workspaceId = workspaceParsed.data;
  const membership = await prisma.membership.findUnique({ where: { userId_workspaceId: { userId: session.userId, workspaceId } } });
  if (!membership) return reply.code(403).send({ error: 'NOT_A_WORKSPACE_MEMBER' });
  const bodyParsed = ItemCreateSchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
  const item = await withWorkspaceTransaction(workspaceId, async (tx) => {
    return tx.item.create({ data: { workspaceId, title: bodyParsed.data.title } });
  });
  reply.code(201).send({ item });
  return;
});

app.get('/api/items', async (req, reply) => {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) return reply.code(401).send({ error: 'NOT_AUTHENTICATED' });
  const workspaceParsed = WorkspaceIdSchema.safeParse((req.headers['x-workspace-id'] as string) || (req.query as any)?.workspaceId);
  if (!workspaceParsed.success) return reply.code(400).send({ error: 'INVALID_WORKSPACE_ID' });
  const workspaceId = workspaceParsed.data;
  const membership = await prisma.membership.findUnique({ where: { userId_workspaceId: { userId: session.userId, workspaceId } } });
  if (!membership) return reply.code(403).send({ error: 'NOT_A_WORKSPACE_MEMBER' });
  const items = await withWorkspaceTransaction(workspaceId, async (tx) => {
    return tx.item.findMany({ where: { workspaceId } });
  });
  return { items };
});

export async function buildServer() {
  return app;
}

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
