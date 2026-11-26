import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  classifyFailure,
  eligibleModels,
  normalizeCooldowns,
  replayQueue,
  selectCheckpointPaths,
  setCooldown,
  stableTaskId,
} from '../scripts/controller-core.mjs';

const REAL_QUOTA_LINE = '\u001b[91m\u001b[1mError: \u001b[0mFree usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.';

describe('classifyFailure', () => {
  it('recognises all five real global free-quota occurrences', () => {
    // The five occurrences in docs/completion/autonomous-controller.log have
    // the same message with different surrounding output and ANSI colouring.
    const occurrences = [
      REAL_QUOTA_LINE,
      `some prior output\n${REAL_QUOTA_LINE}`,
      `${REAL_QUOTA_LINE}\n    at runAgent (controller.mjs:1:1)`,
      `\u001b[91mError: \u001b[0mFree usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.`,
      `Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.`,
    ];
    for (const occurrence of occurrences) {
      expect(classifyFailure(occurrence, 1)).toBe('GLOBAL_FREE_QUOTA');
    }
  });

  it('keeps provider quota, model 429, infra, auth and code failures distinct', () => {
    expect(classifyFailure('Error: provider quota exceeded for account', 1)).toBe('PROVIDER_LIMIT');
    expect(classifyFailure('HTTP 429: rate limit exceeded for opencode/big-pickle', 429)).toBe('MODEL_RATE_LIMIT');
    expect(classifyFailure('ETIMEDOUT: socket hang up', 1)).toBe('INFRA');
    expect(classifyFailure('command killed', 137)).toBe('INFRA');
    expect(classifyFailure('503 service unavailable', 1)).toBe('INFRA');
    expect(classifyFailure('Missing credentials for provider', 1)).toBe('AUTH_BLOCKER');
    expect(classifyFailure('HTTP 402 payment required', 402)).toBe('AUTH_BLOCKER');
    expect(classifyFailure('TypeError: cannot read properties of undefined', 1)).toBe('CODE_FAIL');
  });
});

describe('cooldowns and backoff', () => {
  it('expires cooldowns and follows the capped ladder with Retry-After', () => {
    const now = Date.parse('2026-11-24T00:00:00.000Z');
    const cooled = setCooldown({}, 'model', 'opencode/big-pickle', now + 60_000, 'MODEL_RATE_LIMIT', now);
    expect(normalizeCooldowns(cooled, now).models['opencode/big-pickle']).toBeDefined();
    expect(normalizeCooldowns(cooled, now + 61_000).models['opencode/big-pickle']).toBeUndefined();

    expect([1, 2, 3, 4, 5, 6, 7, 9].map((level) => backoffMs(level))).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 3_600_000, 21_600_000, 21_600_000,
    ]);
    expect(backoffMs(3, 300)).toBe(300_000);
    expect(backoffMs(1, 60)).toBe(60_000);
    expect(backoffMs(1, '120')).toBe(120_000);
  });
});

describe('replayQueue', () => {
  it('returns interrupted leases as pending with unchanged attempts', () => {
    const crashEvents = [
      { type: 'enqueue', taskId: 'abc123', text: 'task one', attempts: 2, at: 1 },
      { type: 'claim', taskId: 'abc123', attempts: 2, at: 2 },
    ];
    const replay = replayQueue(crashEvents);
    expect(replay.recovered).toHaveLength(1);
    expect(replay.inFlight).toEqual([]);
    expect(replay.pending).toHaveLength(1);
    expect(replay.pending[0]).toMatchObject({ taskId: 'abc123', text: 'task one', attempts: 2 });

    const resumed = replayQueue([
      ...crashEvents,
      { type: 'requeue', taskId: 'abc123', attempts: 2, reason: 'crash-recovery', at: 3 },
      { type: 'claim', taskId: 'abc123', attempts: 2, at: 4 },
      { type: 'complete', taskId: 'abc123', attempts: 2, at: 5 },
    ]);
    expect(resumed.pending).toEqual([]);
    expect(resumed.recovered).toEqual([]);
    expect(resumed.completed).toHaveLength(1);
  });

  it('retires stale roadmap discoveries without counting them as failures', () => {
    const events = [
      { type: 'enqueue', taskId: 'stale1', text: 'Roadmap: docs/autonomous-build/PHASE-23.md:321:Next: Phase 24', at: 1 },
      { type: 'enqueue', taskId: 'live1', text: 'Complete feature: Self-Improving (missing)', at: 2 },
      { type: 'obsolete', taskId: 'stale1', text: 'Roadmap: docs/autonomous-build/PHASE-23.md:321:Next: Phase 24', reason: 'STALE_ROADMAP_DISCOVERY', at: 3 },
    ];
    const replay = replayQueue(events);
    expect(replay.obsolete).toHaveLength(1);
    expect(replay.failed).toEqual([]);
    expect(replay.pending.map((task) => task.taskId)).toEqual(['live1']);
  });
});

describe('eligibleModels', () => {
  it('never falls back to a paid model when free models are cooling', () => {
    const now = Date.parse('2026-11-24T00:00:00.000Z');
    const catalog = [
      'opencode/big-pickle',
      'anthropic/claude-sonnet',
      'opencode/beam-free',
      'openai/gpt-5',
    ];
    const oneCooled = setCooldown({}, 'model', 'opencode/big-pickle', now + 60_000, 'MODEL_RATE_LIMIT', now);
    expect(eligibleModels(catalog, oneCooled, now)).toEqual(['opencode/beam-free']);

    const providerCooled = setCooldown(oneCooled, 'provider', 'opencode', now + 3_600_000, 'GLOBAL_FREE_QUOTA', now);
    expect(eligibleModels(catalog, providerCooled, now)).toEqual([]);
    expect(eligibleModels(catalog, providerCooled, now + 3_600_001)).toEqual([
      'opencode/big-pickle',
      'opencode/beam-free',
    ]);
  });
});

describe('selectCheckpointPaths', () => {
  it('selects only newly dirty allowlisted paths in a dirty user tree', () => {
    const baseline = [
      ' M .env',
      ' M docs/autonomous-build/STATE.md',
      ' M src/generated/prisma/client.ts',
      ' M src/index.ts',
      '?? docs/completion/controller/state.json',
    ];
    const current = [
      ...baseline,
      ' M .env',
      ' M docs/autonomous-build/STATE.md',
      ' M src/generated/prisma/client.ts',
      ' M src/jobs.ts',
      '?? tests/controller-core.test.ts',
      ' M prisma/schema.prisma',
      ' M prisma/schema.prisma.backup',
      ' M docs/completion/controller/controller.log',
      ' M logs/run.log',
      ' M docs/completion/FEATURE_MATRIX.json',
    ];
    expect(selectCheckpointPaths(baseline, current)).toEqual([
      'prisma/schema.prisma',
      'src/jobs.ts',
      'tests/controller-core.test.ts',
    ]);
    expect(stableTaskId('task')).toMatch(/^[0-9a-f]{12}$/);
  });
});
