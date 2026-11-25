import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { writeAuditEvent } from '../lib/audit.js';
import { prisma } from '../lib/db.js';
import { redactData, redactError, redactText } from '../lib/redaction.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('central error redaction', () => {
  it('redacts secret assignments, JWTs, URL credentials and bearer tokens', () => {
    const sample = [
      'SESSION_JWT_SECRET=supersecretvalue1234567890 fail',
      'MECE_DASHBOARD_TOKEN: abcdefghijklmnop',
      'OPENCODE_SERVER_PASSWORD=hunter2',
      'postgres://app:password@db.internal:5432/ugc connection failed',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    ].join(' | ');
    const safe = redactText(sample);
    expect(safe).not.toContain('supersecretvalue1234567890');
    expect(safe).not.toContain('abcdefghijklmnop');
    expect(safe).not.toContain('hunter2');
    expect(safe).not.toContain('password@db.internal');
    expect(safe).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature');
    expect(safe).toContain('SESSION_JWT_SECRET=[REDACTED]');
    expect(safe).toContain('Bearer [REDACTED]');
  });

  it('preserves harmless error codes while redacting structured audit data', () => {
    const safe = redactData({
      code: 'NOT_CONFIGURED',
      reason: 'DATABASE_URL=postgresql://u:p@host/db unavailable',
      credentials: { apiKey: 'key-123', password: 'pw-456' },
      deep: { nested: { token: 'tok-789' } },
      count: 3,
    }) as any;
    expect(safe.code).toBe('NOT_CONFIGURED');
    expect(safe.count).toBe(3);
    expect(safe.reason).toContain('DATABASE_URL=[REDACTED]');
    expect(safe.reason).not.toContain('u:p@host');
    expect(safe.credentials.apiKey).toBe('[REDACTED]');
    expect(safe.credentials.password).toBe('[REDACTED]');
    expect(safe.deep.nested.token).toBe('[REDACTED]');
  });

  it('redacts error stacks before they are logged', () => {
    const safe = redactError(Object.assign(new Error('API_KEY=leaked-key failed'), {
      statusCode: 400,
      stack: 'Error: API_KEY=leaked-key failed\n    at /app/secret.js:1:1',
    })) as any;
    expect(safe.message).not.toContain('leaked-key');
    expect(safe.stack).not.toContain('leaked-key');
    expect(safe.statusCode).toBe(400);
  });

  it('persists only redacted audit payloads', async () => {
    const event = await writeAuditEvent({
      type: 'redaction_regression',
      actor: 'redaction-test',
      data: {
        message: 'OPENCODE_SERVER_PASSWORD=do-not-store-this',
        apiKey: 'do-not-store-this-either',
        code: 'OK',
      },
    });
    try {
      const row: any = await prisma.auditEvent.findUnique({ where: { id: event.id } });
      expect(row).toBeTruthy();
      expect(row.data).toEqual({
        message: 'OPENCODE_SERVER_PASSWORD=[REDACTED]',
        apiKey: '[REDACTED]',
        code: 'OK',
      });
    } finally {
      await prisma.auditEvent.delete({ where: { id: event.id } });
    }
  });
});
