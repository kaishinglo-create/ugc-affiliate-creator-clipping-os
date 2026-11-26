import { describe, expect, it, vi } from 'vitest';
import {
  KNOWN_ERROR_CODES,
  REQUIRED_QUALITY_GATES,
  SAFE_HEALING_ACTIONS,
  applyHealing,
  classifyError,
  classifyErrorCode,
  collectHealingProposals,
  proposeHealing,
  rollbackHealingMutations,
  type HealingAuditEvent,
  type HealingContext,
  type HealingProposal,
  type HealingState,
  type HealingStateStore,
  type HealingTarget,
  type HealingVerifyInput,
  type QualityGateReport,
} from '../src/self-healing.js';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const WS = 'sh-ws-1';
const WINDOW = { workspaceId: WS, now: NOW, windowMs: 60_000 } as const;

function auditEvent(
  id: string,
  type: string,
  data: unknown = {},
  secondsAgo = 1,
  workspaceId: string | null = WS,
): HealingAuditEvent {
  return {
    id,
    workspaceId,
    type,
    createdAt: new Date(NOW.getTime() - secondsAgo * 1_000),
    data,
  };
}

function staleEvents(jobId: string, ids: readonly string[]): HealingAuditEvent[] {
  return ids.map((id, index) =>
    auditEvent(id, 'engine_tick_error', { code: 'STALE_LEASE', jobId }, index + 1));
}

function staleProposal(jobId = 'job-1'): HealingProposal {
  const [proposal] = proposeHealing(staleEvents(jobId, ['ae-stale']), WINDOW);
  if (!proposal) throw new Error('TEST_SETUP: no stale-lease proposal');
  return proposal;
}

function retryProposal(jobId: string): HealingProposal {
  const [proposal] = proposeHealing(
    [auditEvent(`ae-retry-${jobId}`, 'job_retry_wait', { code: 'RETRY_WAIT_DUE', jobId })],
    WINDOW,
  );
  if (!proposal) throw new Error('TEST_SETUP: no retry-wait proposal');
  return proposal;
}

function jobState(id: string, overrides: Partial<HealingState> = {}): HealingState {
  return {
    id,
    workspaceId: WS,
    kind: 'job',
    status: 'RUNNING',
    leaseOwner: 'worker-1',
    leaseToken: `token-${id}`,
    leaseExpiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
    heartbeatAt: new Date(NOW.getTime() - 30_000).toISOString(),
    runAt: new Date(NOW.getTime() - 30_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 120_000).toISOString(),
    ...overrides,
  };
}

class MemoryStateStore implements HealingStateStore {
  readonly rows = new Map<string, HealingState>();
  readonly reads: string[] = [];
  readonly writes: Array<{ id: string; state: HealingState }> = [];
  failWriteFor: string | null = null;

  constructor(initial: readonly HealingState[] = []) {
    for (const row of initial) this.rows.set(`${row.kind}:${row.id}`, { ...row });
  }

  private key(ref: { kind: string; id: string }): string {
    return `${ref.kind}:${ref.id}`;
  }

  async read(ref: HealingTarget): Promise<HealingState | null> {
    this.reads.push(this.key(ref));
    const row = this.rows.get(this.key(ref));
    return row ? { ...row } : null;
  }

  async write(state: HealingState): Promise<void> {
    if (this.failWriteFor === state.id) throw new Error('WRITE_BLOCKED');
    this.rows.set(this.key(state), { ...state });
    this.writes.push({ id: state.id, state: { ...state } });
  }
}

function passingGates(overrides: Partial<QualityGateReport['gates']> = {}): QualityGateReport {
  return { ok: true, gates: { typecheck: true, lint: true, tests: true, ...overrides } };
}

function context(store: HealingStateStore, overrides: Partial<HealingContext> = {}): HealingContext {
  return {
    workspaceId: WS,
    actor: 'self-healing-test',
    dryRun: false,
    approved: true,
    allowedActions: [...SAFE_HEALING_ACTIONS],
    store,
    verify: () => passingGates(),
    now: NOW,
    staleLeaseMs: 60_000,
    ...overrides,
  };
}

describe('error classification (transversal)', () => {
  const expectations: Record<string, {
    retryable: boolean;
    requiresExternalSetup: boolean;
    manualApproval: boolean;
    severity: string;
    category: string;
  }> = {
    NOT_CONFIGURED: { retryable: false, requiresExternalSetup: true, manualApproval: true, severity: 'error', category: 'configuration' },
    MEDIA_NOT_FOUND: { retryable: false, requiresExternalSetup: true, manualApproval: false, severity: 'warning', category: 'media' },
    INVALID_INPUT: { retryable: false, requiresExternalSetup: false, manualApproval: false, severity: 'info', category: 'input' },
    AI_BUDGET_EXCEEDED: { retryable: false, requiresExternalSetup: true, manualApproval: true, severity: 'warning', category: 'external_limit' },
    RATE_LIMIT: { retryable: false, requiresExternalSetup: true, manualApproval: true, severity: 'warning', category: 'external_limit' },
    QUOTA: { retryable: false, requiresExternalSetup: true, manualApproval: true, severity: 'warning', category: 'external_limit' },
    TRANSIENT: { retryable: true, requiresExternalSetup: false, manualApproval: false, severity: 'warning', category: 'transient' },
    NETWORK: { retryable: true, requiresExternalSetup: false, manualApproval: false, severity: 'warning', category: 'transient' },
    APPROVAL_REQUIRED: { retryable: false, requiresExternalSetup: false, manualApproval: true, severity: 'info', category: 'approval' },
    FFMPEG_FAILED: { retryable: false, requiresExternalSetup: false, manualApproval: false, severity: 'error', category: 'tool_failure' },
    TRANSCRIBE_FAILED: { retryable: false, requiresExternalSetup: false, manualApproval: false, severity: 'error', category: 'tool_failure' },
  };

  it('classifies every known code with all required fields', () => {
    expect([...KNOWN_ERROR_CODES].sort()).toEqual(Object.keys(expectations).sort());
    for (const code of KNOWN_ERROR_CODES) {
      const classification = classifyErrorCode(code);
      const expected = expectations[code];
      expect(classification.code, code).toBe(code);
      expect(classification.retryable, code).toBe(expected.retryable);
      expect(classification.requiresExternalSetup, code).toBe(expected.requiresExternalSetup);
      expect(classification.manualApproval, code).toBe(expected.manualApproval);
      expect(classification.severity, code).toBe(expected.severity);
      expect(classification.category, code).toBe(expected.category);
      expect(classification.action.length, code).toBeGreaterThan(20);
      expect(classification.source, code).toBe('known_code');
    }
  });

  it('never classifies quota as a code defect or a retryable/limit-circumventing error', () => {
    const quotaSignals: unknown[] = [
      'QUOTA',
      'RATE_LIMIT',
      'AI_BUDGET_EXCEEDED',
      'HTTP_402',
      'HTTP_429',
      { status: 402 },
      { status: 429 },
      { code: 'TRANSIENT', httpStatus: 429 },
      { message: 'quota exceeded' },
      { data: { outcome: 'budget_exceeded' } },
      { data: { errorCode: 'out_of_credit' } },
    ];
    for (const signal of quotaSignals) {
      const classification = classifyError(signal);
      expect(['QUOTA', 'RATE_LIMIT', 'AI_BUDGET_EXCEEDED'], JSON.stringify(signal)).toContain(classification.code);
      expect(classification.category, JSON.stringify(signal)).toBe('external_limit');
      expect(classification.retryable, JSON.stringify(signal)).toBe(false);
      expect(classification.manualApproval, JSON.stringify(signal)).toBe(true);
      expect(classification.action, JSON.stringify(signal)).toMatch(/bypass|code defect/i);
    }
    expect(REQUIRED_QUALITY_GATES).toEqual(['typecheck', 'lint', 'tests']);
  });

  it('fails closed for unknown codes and keeps approval manual', () => {
    const unknown = classifyError('SOME_BRAND_NEW_CODE');
    expect(unknown.code).toBe('UNKNOWN');
    expect(unknown.retryable).toBe(false);
    expect(unknown.manualApproval).toBe(true);
    expect(unknown.action).toMatch(/no automatic repair/i);

    const approval = classifyError('APPROVAL_REQUIRED');
    expect(approval.manualApproval).toBe(true);
    expect(approval.action).toMatch(/never auto-approve/i);
    expect(classifyError({ code: 'AI_OUTPUT_INVALID' }).retryable).toBe(true);
  });
});

describe('proposals derive only from real AuditEvent rows', () => {
  it('carries event ids, type/code counts, confidence and applied:false', () => {
    const events = [
      ...staleEvents('job-1', ['ae-1', 'ae-2']),
      auditEvent('ae-q1', 'ollama_request', { outcome: 'budget_exceeded', status: 402 }, 3),
      auditEvent('ae-q2', 'ollama_request', { outcome: 'budget_exceeded', status: 402 }, 4),
      auditEvent('ae-a1', 'approval_rejected', {}, 5),
      auditEvent('ae-foreign', 'engine_tick_error', { code: 'STALE_LEASE', jobId: 'foreign-job' }, 1, 'other-ws'),
    ];
    const proposals = proposeHealing(events, WINDOW);

    const stale = proposals.find((proposal) => proposal.rule === 'stale_lease_recovery');
    expect(stale).toBeDefined();
    expect(stale?.action).toBe('clear_stale_lease');
    expect(stale?.target).toEqual({ kind: 'job', id: 'job-1', workspaceId: WS });
    expect(stale?.evidence.eventIds).toEqual(['ae-1', 'ae-2']);
    expect(stale?.evidence.count).toBe(2);
    expect(stale?.evidence.types).toEqual([{ type: 'engine_tick_error', count: 2 }]);
    expect(stale?.evidence.codes).toEqual([{ code: 'TRANSIENT', count: 2 }]);
    expect(stale?.confidence).toBeGreaterThan(0);
    expect(stale?.confidence).toBeLessThanOrEqual(0.9);

    const quota = proposals.find((proposal) => proposal.rule === 'quota_wait');
    expect(quota).toBeDefined();
    expect(quota?.action).toBeNull();
    expect(quota?.classification.retryable).toBe(false);
    expect(quota?.classification.category).toBe('external_limit');
    expect(quota?.reason).toMatch(/never bypass/i);
    expect(quota?.evidence.eventIds).toEqual(['ae-q1', 'ae-q2']);
    expect(quota?.evidence.count).toBe(2);
    expect(quota?.evidence.types).toEqual([{ type: 'ollama_request', count: 2 }]);
    expect(quota?.evidence.codes).toEqual([{ code: 'QUOTA', count: 2 }]);

    const approval = proposals.find((proposal) => proposal.rule === 'approval_required');
    expect(approval?.action).toBeNull();
    expect(approval?.classification.manualApproval).toBe(true);
    expect(approval?.evidence.eventIds).toEqual(['ae-a1']);

    expect(proposals.every((proposal) => proposal.applied === false)).toBe(true);
    expect(proposals.every((proposal) => proposal.source === 'audit_events')).toBe(true);
    expect(proposals.every((proposal) => !proposal.evidence.eventIds.includes('ae-foreign'))).toBe(true);
  });

  it('ignores rows outside the window and collects through an injected loader', async () => {
    const inWindow = staleEvents('job-1', ['ae-new']);
    const outside = [auditEvent('ae-old', 'engine_tick_error', { code: 'STALE_LEASE', jobId: 'job-old' }, 120)];
    const loader = vi.fn(async () => [...inWindow, ...outside]);
    const report = await collectHealingProposals(WS, loader, { now: NOW, windowMs: 60_000 });

    expect(loader).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, limit: 500 }));
    expect(report.eventsExamined).toBe(2);
    expect(report.truncated).toBe(false);
    expect(report.proposals.map((proposal) => proposal.rule)).toEqual([
      'stale_lease_recovery',
      'transient_observation',
    ]);
    const actionable = report.proposals.filter((proposal) => proposal.action);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].evidence.eventIds).toEqual(['ae-new']);
    expect(actionable[0].applied).toBe(false);

    const truncated = await collectHealingProposals(WS, loader, { now: NOW, windowMs: 60_000, limit: 1 });
    expect(truncated.truncated).toBe(true);
  });
});

describe('controlled apply: dry-run, allowlist and explicit approval', () => {
  it('never mutates on dry-run, missing approval, or a missing allow-list entry', async () => {
    const initial = jobState('job-1');
    const store = new MemoryStateStore([initial]);
    const proposal = staleProposal('job-1');

    const dryRun = await applyHealing(proposal, context(store, { dryRun: true }));
    expect(dryRun.applied).toBe(false);
    expect(dryRun.reason).toBe('DRY_RUN');
    expect(dryRun.mutations).toEqual([]);
    expect(store.writes).toEqual([]);
    expect(store.rows.get('job:job-1')).toEqual(initial);

    const unapproved = await applyHealing(proposal, context(store, { approved: false }));
    expect(unapproved.applied).toBe(false);
    expect(unapproved.reason).toBe('APPROVAL_REQUIRED');
    expect(store.writes).toEqual([]);

    const notAllowed = await applyHealing(proposal, context(store, { allowedActions: [] }));
    expect(notAllowed.applied).toBe(false);
    expect(notAllowed.reason).toBe('ACTION_NOT_ALLOWED');
    expect(store.writes).toEqual([]);
  });

  it('applies a due repair only after all quality gates pass, and rolls back on request', async () => {
    const initial = jobState('job-1');
    const store = new MemoryStateStore([initial]);
    const verify = vi.fn((_input: HealingVerifyInput) => passingGates());
    const result = await applyHealing(staleProposal('job-1'), context(store, { verify }));

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      actor: 'self-healing-test',
      proposals: [{ action: 'clear_stale_lease' }],
    });
    expect(result.applied).toBe(true);
    expect(result.outcome).toBe('applied');
    expect(result.reason).toBe('APPLIED');
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0].before).toEqual(initial);
    expect(result.mutations[0].after).toMatchObject({
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      status: 'RUNNING',
    });
    expect(store.rows.get('job:job-1')).toMatchObject({ status: 'RUNNING', leaseOwner: null });

    const rollback = await result.rollback();
    expect(rollback.rolledBack).toBe(true);
    expect(rollback.reverted.map((mutation) => mutation.ref.id)).toEqual(['job-1']);
    expect(store.rows.get('job:job-1')).toEqual(initial);
    expect(await result.rollback()).toEqual({ rolledBack: true, reverted: [], errors: [] });
  });

  it('refuses live leases, non-due retries and foreign workspaces', async () => {
    const live = jobState('job-1', { leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString() });
    const liveStore = new MemoryStateStore([live]);
    const liveResult = await applyHealing(staleProposal('job-1'), context(liveStore));
    expect(liveResult.applied).toBe(false);
    expect(liveResult.reason).toBe('LIVE_LEASE');
    expect(liveStore.writes).toEqual([]);

    const notDue = jobState('job-2', {
      status: 'RETRY_WAIT',
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      runAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const retryStore = new MemoryStateStore([notDue]);
    const retryResult = await applyHealing(retryProposal('job-2'), context(retryStore));
    expect(retryResult.applied).toBe(false);
    expect(retryResult.reason).toBe('NOT_DUE');
    expect(retryStore.writes).toEqual([]);

    const foreignStore = new MemoryStateStore([jobState('job-1')]);
    const foreign = { ...staleProposal('job-1'), workspaceId: 'other-ws' } as HealingProposal;
    const foreignResult = await applyHealing(foreign, context(foreignStore));
    expect(foreignResult.reason).toBe('WORKSPACE_MISMATCH');
    expect(foreignStore.writes).toEqual([]);
  });

  it('promotes a due RETRY_WAIT job without changing its attempts or runAt', async () => {
    const runAt = new Date(NOW.getTime() - 10_000).toISOString();
    const initial = jobState('job-2', {
      status: 'RETRY_WAIT',
      attempts: 2,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      runAt,
    });
    const store = new MemoryStateStore([initial]);
    const result = await applyHealing(retryProposal('job-2'), context(store));

    expect(result.applied).toBe(true);
    expect(result.mutations[0].before).toEqual(initial);
    expect(store.rows.get('job:job-2')).toMatchObject({ status: 'QUEUED', attempts: 2, runAt });
    await rollbackHealingMutations(result.mutations, store);
    expect(store.rows.get('job:job-2')).toEqual(initial);
  });
});

describe('rollback and quality gates', () => {
  it('rolls back every mutation in reverse order when verification fails', async () => {
    const first = jobState('job-1');
    const second = jobState('job-2');
    const store = new MemoryStateStore([first, second]);
    const verify = vi.fn((_input: HealingVerifyInput) => passingGates({ tests: false }));
    const result = await applyHealing([staleProposal('job-1'), staleProposal('job-2')], context(store, { verify }));

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][0].mutations).toHaveLength(2);
    expect(result.applied).toBe(false);
    expect(result.outcome).toBe('verify_failed');
    expect(result.reason).toBe('VERIFY_FAILED');
    expect(result.rolledBack).toBe(true);
    expect(result.rollbackErrors).toEqual([]);
    expect(result.mutations.map((mutation) => mutation.ref.id)).toEqual(['job-1', 'job-2']);
    expect(store.writes.map((write) => write.id)).toEqual(['job-1', 'job-2', 'job-2', 'job-1']);
    expect(store.rows.get('job:job-1')).toEqual(first);
    expect(store.rows.get('job:job-2')).toEqual(second);
    expect(await result.rollback()).toEqual({ rolledBack: true, reverted: [], errors: [] });
  });

  it('requires all three gates and rolls back when a gate is missing or verify throws', async () => {
    const initial = jobState('job-1');
    const missingGateStore = new MemoryStateStore([initial]);
    const missing = await applyHealing(
      staleProposal('job-1'),
      context(missingGateStore, { verify: () => ({ ok: true, gates: { typecheck: true, lint: true } }) }),
    );
    expect(missing.applied).toBe(false);
    expect(missing.reason).toBe('VERIFY_FAILED');
    expect(missing.message).toMatch(/tests/);
    expect(missingGateStore.rows.get('job:job-1')).toEqual(initial);

    const throwingStore = new MemoryStateStore([initial]);
    const throwing = await applyHealing(
      staleProposal('job-1'),
      context(throwingStore, { verify: () => { throw new Error('GATE_DOWN'); } }),
    );
    expect(throwing.applied).toBe(false);
    expect(throwing.reason).toBe('VERIFY_THREW');
    expect(throwingStore.rows.get('job:job-1')).toEqual(initial);
  });

  it('rolls back earlier writes when a later store write fails', async () => {
    const first = jobState('job-1');
    const second = jobState('job-2');
    const store = new MemoryStateStore([first, second]);
    store.failWriteFor = 'job-2';
    const result = await applyHealing([staleProposal('job-1'), staleProposal('job-2')], context(store));

    expect(result.applied).toBe(false);
    expect(result.outcome).toBe('mutation_failed');
    expect(result.rolledBack).toBe(true);
    expect(store.writes.map((write) => write.id)).toEqual(['job-1', 'job-1']);
    expect(store.rows.get('job:job-1')).toEqual(first);
    expect(store.rows.get('job:job-2')).toEqual(second);
  });
});

describe('approval and quota cannot be bypassed', () => {
  it('keeps approval suggestions advisory even with an approved, allow-all context', async () => {
    const events = [
      auditEvent('ae-a1', 'approval_rejected', {}),
      auditEvent('ae-a2', 'orchestration_approval_decided', { approved: false }, 2),
    ];
    const [approval] = proposeHealing(events, WINDOW);
    expect(approval.rule).toBe('approval_required');
    expect(approval.action).toBeNull();
    expect(approval.classification.manualApproval).toBe(true);

    const store = new MemoryStateStore([jobState('job-1')]);
    const result = await applyHealing(approval, context(store, { approved: true }));
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('ADVISORY_ONLY');
    expect(store.writes).toEqual([]);

    const forged = {
      ...approval,
      action: 'clear_stale_lease',
      target: { kind: 'job', id: 'job-1', workspaceId: WS },
      classification: classifyError('APPROVAL_REQUIRED'),
    } as HealingProposal;
    const forgedResult = await applyHealing(forged, context(store));
    expect(forgedResult.applied).toBe(false);
    expect(forgedResult.reason).toBe('MANUAL_APPROVAL_REQUIRED');
    expect(store.writes).toEqual([]);
  });

  it('never applies a quota suggestion or retries a quota error', async () => {
    const quotaEvents = [
      auditEvent('ae-q1', 'ollama_request', { outcome: 'budget_exceeded', status: 402 }),
      auditEvent('ae-q2', 'ollama_request', { outcome: 'budget_exceeded', status: 402 }, 2),
    ];
    const [quota] = proposeHealing(quotaEvents, WINDOW);
    expect(quota.rule).toBe('quota_wait');
    expect(quota.classification.retryable).toBe(false);
    expect(quota.classification.action).toMatch(/not be bypassed|never bypass/i);

    const store = new MemoryStateStore([jobState('job-1')]);
    const result = await applyHealing(quota, context(store));
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('ADVISORY_ONLY');
    expect(store.writes).toEqual([]);
  });
});
