import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { buildServer } from '../src/index.js';
import {
  collectSelfImprovement,
  deriveSuggestions,
  type SelfImprovementEvent,
} from '../src/self-improving.js';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const PURE_WORKSPACE = 'si-pure-workspace';

function event(
  type: string,
  secondsAgo: number,
  data?: unknown,
  workspaceId: string | null = PURE_WORKSPACE,
): SelfImprovementEvent {
  return {
    workspaceId,
    type,
    createdAt: new Date(NOW.getTime() - secondsAgo * 1_000),
    data,
  };
}

function quotaEvents(count: number): SelfImprovementEvent[] {
  return Array.from({ length: count }, (_, i) =>
    event('ollama_request', i + 1, { outcome: 'budget_exceeded', status: 'budget_exceeded' }),
  );
}

describe('self-improving rules learner (pure derivation)', () => {
  it('returns no suggestions without evidence in the window', () => {
    expect(deriveSuggestions([], NOW)).toEqual([]);
    expect(deriveSuggestions([
      event('ollama_request', 1, { outcome: 'success', status: 200 }),
      event('approval_rejected', 100 * 60, undefined), // outside a 60-second window
      { workspaceId: PURE_WORKSPACE, type: 'engine_tick_error', createdAt: 'not-a-date' },
    ], NOW, { workspaceId: PURE_WORKSPACE, windowMs: 60_000 })).toEqual([]);
  });

  it('suggests waiting for free quota and never a paid fallback', () => {
    const suggestions = deriveSuggestions(quotaEvents(3), NOW, {
      workspaceId: PURE_WORKSPACE,
      windowMs: 60_000,
    });
    expect(suggestions).toHaveLength(1);
    const [suggestion] = suggestions;
    expect(suggestion.evidence.rule).toBe('repeated_quota_errors');
    expect(suggestion.evidence.count).toBe(3);
    expect(suggestion.evidence.window).toEqual({
      from: new Date(NOW.getTime() - 60_000).toISOString(),
      to: NOW.toISOString(),
      durationMs: 60_000,
    });
    expect(suggestion.suggestedAction).toMatch(/wait for free quota/i);
    expect(suggestion.suggestedAction).toMatch(/do not enable a paid fallback/i);
    expect(suggestion.source).toBe('audit_events');
    expect(suggestion.status).toBe('suggested');
    expect(suggestion.confidence).toBeGreaterThan(0.4);
    expect(suggestion.workspaceId).toBe(PURE_WORKSPACE);
  });

  it('reports recurring engine errors with counts and stable determinism', () => {
    const events = [
      event('engine_tick_error', 1, { error: 'TICK_FAILED' }),
      event('orchestration_engine_error', 2, { error: 'DRIVER_ERROR' }),
      event('engine_job_failed', 3, { error: 'LEASE_LOST' }),
      event('orchestration_task_failed', 4, { error: 'TASK_FAILED' }),
      event('engine_job_claimed', 5, undefined),
    ];
    const options = { workspaceId: PURE_WORKSPACE, windowMs: 60_000 };
    const first = deriveSuggestions(events, NOW, options);
    expect(first).toHaveLength(1);
    const [suggestion] = first;
    expect(suggestion.evidence.rule).toBe('repeated_engine_orchestration_errors');
    expect(suggestion.evidence.count).toBe(4);
    expect(suggestion.evidence.matchedTypes).toEqual([
      { type: 'engine_job_failed', count: 1 },
      { type: 'engine_tick_error', count: 1 },
      { type: 'orchestration_engine_error', count: 1 },
      { type: 'orchestration_task_failed', count: 1 },
    ]);
    expect(suggestion.suggestedAction).toMatch(/kill switch/i);
    expect(deriveSuggestions([...events].reverse(), NOW, options)).toEqual(first);
  });

  it('ignores foreign workspace events and suggests sharper approval criteria', () => {
    const events = [
      ...Array.from({ length: 3 }, (_, i) => event('approval_rejected', i + 1)),
      event('approval_rejected', 1, undefined, 'other-workspace'),
      event('orchestration_approval_decided', 1, { approved: true }),
    ];
    const suggestions = deriveSuggestions(events, NOW, {
      workspaceId: PURE_WORKSPACE,
      windowMs: 60_000,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].evidence.count).toBe(3);
    expect(suggestions[0].suggestedAction).toMatch(/sharpen the approval criteria/i);
  });
});

describe('self-improving API', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it('returns an advisory, workspace-scoped report without applying changes', async () => {
    const suffix = randomUUID();
    const email = `si-api-${suffix.slice(0, 12)}@x.com`;
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'password1234', workspaceName: 'SI API', workspaceSlug: `si-api-${suffix}` } });
    expect(signup.statusCode).toBe(201);
    const workspaceId = signup.json().workspace.id;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password1234' } });
    const cookie = login.headers['set-cookie'];
    const res = await app.inject({
      method: 'GET',
      url: '/api/self-improving?windowMs=60000',
      headers: { cookie, 'x-workspace-id': workspaceId },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json().selfImprovement;
    expect(report.workspaceId).toBe(workspaceId);
    expect(Array.isArray(report.suggestions)).toBe(true);
    expect(report.suggestions.every((s: any) => s.status === 'suggested' && s.source === 'audit_events')).toBe(true);
    expect(report).not.toHaveProperty('applied');
  }, 60_000);
});

describe('self-improving rules learner (database-backed)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('derives suggestions only from stored rows in the requested workspace', async () => {
    const suffix = randomUUID();
    const foreignWorkspaceId = `si-foreign-${suffix.slice(0, 12)}`;
    const created = await prisma.workspace.create({
      data: { name: 'self-improving test', slug: `si-${suffix}` },
    });
    const ownWorkspaceId = created.id;

    try {
      await withWorkspaceTransaction(ownWorkspaceId, async (tx) => {
        for (let i = 0; i < 3; i += 1) {
          await tx.auditEvent.create({
            data: {
              workspaceId: ownWorkspaceId,
              type: 'ollama_request',
              actor: null,
              data: { outcome: 'budget_exceeded', status: 'budget_exceeded' },
              createdAt: new Date(NOW.getTime() - (i + 1) * 10_000),
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            workspaceId: ownWorkspaceId,
            type: 'ollama_request',
            actor: null,
            data: { outcome: 'success', status: 200 },
            createdAt: new Date(NOW.getTime() - 10_000),
          },
        });
      });

      // Stored in a different workspace; must not leak into this report.
      await withWorkspaceTransaction(foreignWorkspaceId, (tx) =>
        tx.auditEvent.create({
          data: {
            workspaceId: foreignWorkspaceId,
            type: 'engine_tick_error',
            actor: null,
            data: { error: 'TICK_FAILED' },
            createdAt: new Date(NOW.getTime() - 10_000),
          },
        }),
      );

      const report = await collectSelfImprovement(ownWorkspaceId, {
        now: NOW,
        windowMs: 60_000,
        minOccurrences: 3,
      });
      expect(report.workspaceId).toBe(ownWorkspaceId);
      expect(report.eventsExamined).toBe(4);
      expect(report.truncated).toBe(false);
      expect(report.suggestions).toHaveLength(1);
      const [suggestion] = report.suggestions;
      expect(suggestion.workspaceId).toBe(ownWorkspaceId);
      expect(suggestion.source).toBe('audit_events');
      expect(suggestion.status).toBe('suggested');
      expect(suggestion.evidence.count).toBe(3);
      expect(suggestion.suggestedAction).toMatch(/do not enable a paid fallback/i);
    } finally {
      await withWorkspaceTransaction(foreignWorkspaceId, (tx) =>
        tx.auditEvent.deleteMany({ where: { workspaceId: foreignWorkspaceId } }),
      );
      await withWorkspaceTransaction(ownWorkspaceId, (tx) =>
        tx.auditEvent.deleteMany({ where: { workspaceId: ownWorkspaceId } }),
      );
      await prisma.workspace.delete({ where: { id: ownWorkspaceId } });
    }
  });
});
