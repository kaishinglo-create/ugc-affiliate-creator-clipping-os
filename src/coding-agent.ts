/**
 * Phase I.4: isolated coding-agent sandbox.
 *
 * Disabled by default (PHASE_I_SANDBOX_ENABLED=1). A sandbox is a git worktree
 * under a fixed scratch root with .env excluded, bounded commands and no
 * commits, pushes, PRs or merges. Model use is free-only; no secret is copied.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { assertSandboxCommand, evaluateSandboxChanges, sandboxCapabilities } from './sandbox-policy.js';

export { sandboxCapabilities };

const SANDBOX_ROOT = process.env.PHASE_I_SANDBOX_DIR?.trim() || '/tmp/opencode/phase-i-sandboxes';
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function invalid(code: string, status = 400): Error {
  return Object.assign(new Error(code), { statusCode: status });
}

export function sandboxEnabled(): boolean {
  return /^(1|true)$/i.test(String(process.env.PHASE_I_SANDBOX_ENABLED ?? '').trim());
}

function run(command: string, args: string[], cwd: string, timeoutMs = 60_000): string {
  return execFileSync(command, args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export async function createSandbox(input: {
  workspaceId: string;
  actor: string | null;
  label: string;
}): Promise<any> {
  if (!sandboxEnabled()) throw invalid('SANDBOX_NOT_CONFIGURED', 503);
  const label = String(input.label ?? '').trim();
  if (!NAME_RE.test(label)) throw invalid('INVALID_SANDBOX_LABEL');
  const id = `${label}-${Date.now().toString(36)}`;
  if (!NAME_RE.test(id)) throw invalid('INVALID_SANDBOX_LABEL');
  const root = join(SANDBOX_ROOT, id);
  if (existsSync(root)) throw invalid('SANDBOX_EXISTS', 409);
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const repoRoot = process.cwd();
  run('git', ['worktree', 'add', '-b', `phase-i/${id}`, root, 'HEAD'], repoRoot, 120_000);
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const row: any = await tx.sandboxRun.create({
      data: { workspaceId: input.workspaceId, worktreePath: root, status: 'created' },
    });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'sandbox_created', actor: input.actor ?? 'coding-agent',
      data: { sandboxId: row.id, worktreePath: root },
    });
    return row;
  });
}

/** Deterministic patch proposal from persisted evidence; never claims AI output. */
export async function proposePatch(input: {
  workspaceId: string;
  sandboxId: string;
  taskTitle: string;
  evidence: Record<string, unknown>;
  actor: string | null;
  changes?: Array<{ path: string }>;
}): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const row: any = await tx.sandboxRun.findFirst({ where: { id: input.sandboxId, workspaceId: input.workspaceId } });
    if (!row) throw invalid('SANDBOX_NOT_FOUND', 404);
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const evaluation = evaluateSandboxChanges(changes, row.worktreePath);
    if (!evaluation.allowed) throw invalid('SANDBOX_POLICY_VIOLATION', 403);
    const patch = {
      source: 'deterministic_planner',
      title: String(input.taskTitle ?? '').slice(0, 300),
      evidence: input.evidence,
      changes,
      note: 'No automatic source modification; human review required before any patch is applied.',
    };
    const updated: any = await tx.sandboxRun.update({ where: { id: row.id }, data: { status: 'patch_proposed', patchJson: patch } });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'sandbox_patch_proposed', actor: input.actor ?? 'coding-agent',
      data: { sandboxId: row.id, source: patch.source },
    });
    return updated;
  });
}

/** Bounded verification inside the worktree; failures are recorded honestly. */
export async function runSandboxTests(input: {
  workspaceId: string;
  sandboxId: string;
  actor: string | null;
  timeoutMs?: number;
}): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const row: any = await tx.sandboxRun.findFirst({ where: { id: input.sandboxId, workspaceId: input.workspaceId } });
    if (!row) throw invalid('SANDBOX_NOT_FOUND', 404);
    const timeout = Math.max(10_000, Math.min(300_000, Number(input.timeoutMs) || 120_000));
    const tests: Record<string, unknown> = {};
    for (const [name, command, args] of [
      ['typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
      ['lint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.']],
    ] as Array<[string, string, string[]]>) {
      try {
        assertSandboxCommand(command, args);
        run(command, args, row.worktreePath, timeout);
        tests[name] = { ok: true };
      } catch {
        tests[name] = { ok: false };
      }
    }
    const ok = Object.values(tests).every((entry: any) => entry.ok);
    const updated: any = await tx.sandboxRun.update({
      where: { id: row.id }, data: { status: ok ? 'tests_passed' : 'tests_failed', testsJson: tests },
    });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'sandbox_tests', actor: input.actor ?? 'coding-agent',
      data: { sandboxId: row.id, ok, checks: Object.keys(tests) },
    });
    return updated;
  });
}

/** Independent review result plus mandatory human approval. */
export async function reviewSandbox(input: {
  workspaceId: string;
  sandboxId: string;
  actor: string;
  approved: boolean;
}): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const row: any = await tx.sandboxRun.findFirst({ where: { id: input.sandboxId, workspaceId: input.workspaceId } });
    if (!row) throw invalid('SANDBOX_NOT_FOUND', 404);
    if (row.status !== 'tests_passed') throw invalid('SANDBOX_TESTS_REQUIRED', 409);
    const review = { reviewer: input.actor, approved: input.approved, at: new Date().toISOString() };
    const updated: any = await tx.sandboxRun.update({
      where: { id: row.id },
      data: { status: input.approved ? 'approved_for_human' : 'rejected', reviewJson: review, ...(input.approved ? { approvedBy: input.actor } : {}) },
    });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: input.approved ? 'sandbox_approved_for_human' : 'sandbox_rejected', actor: input.actor,
      data: { sandboxId: row.id },
    });
    return updated;
  });
}

/** Remove a sandbox worktree; never touches the primary working tree. */
export async function destroySandbox(input: {
  workspaceId: string;
  sandboxId: string;
  actor: string | null;
}): Promise<any> {
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const row: any = await tx.sandboxRun.findFirst({ where: { id: input.sandboxId, workspaceId: input.workspaceId } });
    if (!row) throw invalid('SANDBOX_NOT_FOUND', 404);
    try {
      run('git', ['worktree', 'remove', '--force', row.worktreePath], process.cwd(), 60_000);
    } catch { /* already removed */ }
    const updated: any = await tx.sandboxRun.update({ where: { id: row.id }, data: { status: 'destroyed' } });
    await writeAuditEvent({
      tx, workspaceId: input.workspaceId, userId: input.actor, runId: null,
      type: 'sandbox_destroyed', actor: input.actor ?? 'coding-agent', data: { sandboxId: row.id },
    });
    return updated;
  });
}
