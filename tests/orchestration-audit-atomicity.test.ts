import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';

describe('orchestration audit atomicity regression', () => {
  it('passes the transaction to each critical orchestration audit event', () => {
    const source = readFileSync(join(process.cwd(), 'src/orchestration.ts'), 'utf8');
    const types = [
      'orchestration_task_succeeded',
      'orchestration_succeeded',
      'orchestration_cancel_requested',
      'orchestration_cancel_failed',
      'orchestration_approval_decided',
    ];
    for (const type of types) {
      const start = source.indexOf("type: '" + type + "'");
      if (type === 'orchestration_cancel_failed') {
        const conditional = source.indexOf("type: cancelErrors.length ? 'orchestration_cancel_failed'");
        expect(conditional).toBeGreaterThan(-1);
        expect(source.slice(conditional, source.indexOf('});', conditional) + 3)).toMatch(/,\s*tx\s*}\);/);
      } else {
        expect(start, type).toBeGreaterThan(-1);
        expect(source.slice(start, source.indexOf('});', start) + 3)).toMatch(/,\s*tx\s*}\);/);
      }
    }
  });

  it('rolls back a state update if its audit insert fails', async () => {
    const id = 'audit-atomicity-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    await prisma.workspace.create({ data: { id, name: 'Before', slug: id } });
    try {
      await expect(withWorkspaceTransaction(id, async (tx: any) => {
        await tx.workspace.update({ where: { id }, data: { name: 'After' } });
        await writeAuditEvent({ workspaceId: id, type: null as unknown as string, tx });
      })).rejects.toThrow();
      const persisted = await prisma.workspace.findUnique({ where: { id } });
      expect(persisted?.name).toBe('Before');
    } finally {
      await prisma.workspace.delete({ where: { id } });
    }
  });
});
