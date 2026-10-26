import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { prisma } from './db.js';

const SESSION_COOKIE = 'ugc_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const BCRYPT_ROUNDS = 12;

function requireSecret() {
  const secret = process.env.SESSION_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error('SESSION_JWT_SECRET_NOT_CONFIGURED');
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string) {
  const rawToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const session = await prisma.session.create({ data: { userId, tokenHash: hashToken(rawToken), expiresAt } });
  const jwt = await new SignJWT({ sid: session.id, tok: rawToken })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(requireSecret());
  return { jwt, expiresAt };
}

export async function verifySession(jwt: string | null) {
  if (!jwt) return null;
  let payload: any;
  try {
    ({ payload } = await jwtVerify(jwt, requireSecret()));
  } catch {
    return null;
  }
  const sessionId = payload.sid;
  const rawToken = payload.tok;
  const userId = payload.sub;
  if (typeof sessionId !== 'string' || typeof rawToken !== 'string' || typeof userId !== 'string') return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  if (session.tokenHash !== hashToken(rawToken)) return null;
  if (session.userId !== userId) return null;
  return { userId, sessionId };
}

export function sessionCookieHeader(jwt: string, expiresAt: Date) {
  const secure = process.env.APP_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${jwt}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function readSessionCookie(req: any) {
  const header = req.headers?.cookie;
  if (!header) return null;
  const match = String(header).split(';').map((p: string) => p.trim()).find((p: string) => p.startsWith(`${SESSION_COOKIE}=`));
  return match ? match.slice(SESSION_COOKIE.length + 1) : null;
}

export async function resolveMembership(userId: string, workspaceId: string) {
  return prisma.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
}
