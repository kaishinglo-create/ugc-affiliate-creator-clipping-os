import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/db.js';
import { evaluateClip, listQualityReports } from '../src/quality-gate.js';

const workspaceIds: string[] = [];
afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.$disconnect();
});

describe('Phase G quality gate', () => {
  it('persists a failed report for a missing clip and never passes it', async () => {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await prisma.workspace.create({ data: { id: workspaceId, name: 'Quality test', slug: workspaceId } });
    const result = await evaluateClip({ workspaceId, clipPath: '/tmp/definitely-missing-phase-g.mp4', rightsStatus: 'AUTHORIZED' });
    expect(result.passed).toBe(false);
    expect(result.checks.some((check) => check.key === 'file_integrity' && !check.passed)).toBe(true);
    const reports = await listQualityReports(workspaceId);
    expect(reports).toHaveLength(1);
    expect(reports[0].passed).toBe(false);
  });
});
