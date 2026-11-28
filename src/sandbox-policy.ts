/**
 * Phase I.4 sandbox policy.
 *
 * A git worktree alone is NOT a secure sandbox. On this host no OS-level
 * namespaces/seccomp isolation is available, therefore the coding agent stays
 * disabled by default (PHASE_I_SANDBOX_ENABLED). When explicitly enabled for a
 * controlled test, these checks enforce the strongest available boundaries:
 * path containment (including symlink resolution), forbidden governance files,
 * command allowlisting and forbidden git write operations.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const GOVERNANCE_PATHS: readonly string[] = [
  'docs/completion/controller/STOP',
  'docs/completion/controller/state.json',
  '.env',
  '.env.example',
  'PHASE_I_TASKS.json',
  'PHASE_I_MASTERPROMPT.md',
  'src/media-release.ts',
  'src/quality-gate.ts',
  'lib/security.ts',
  'src/ai/agent-runtime.ts',
  'src/recovery-engine.ts',
];

const ALLOWED_COMMANDS = new Set(['node', process.execPath]);
const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'rev-parse']);

function denied(code: string): never {
  throw Object.assign(new Error(code), { statusCode: 403 });
}

export function sandboxCapabilities(): Record<string, unknown> {
  return {
    osNamespaces: 'unavailable',
    seccomp: 'unavailable',
    networkPolicy: 'host_default_no_agent_network_calls',
    failClosedByDefault: true,
    optInEnv: 'PHASE_I_SANDBOX_ENABLED',
    note: 'No effective OS-level isolation on this hardware; agent disabled unless explicitly opted in for controlled tests.',
  };
}

/** Resolve a path inside the worktree and reject symlink/escape/governance targets. */
export function assertSandboxPath(worktreePath: string, requested: string): string {
  const root = realpathSync(worktreePath);
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) denied('SANDBOX_PATH_ESCAPE');
  const normalized = rel.split(sep).join('/');
  if (GOVERNANCE_PATHS.some((forbidden) => normalized === forbidden || normalized.startsWith(`${forbidden}/`))) {
    denied('SANDBOX_GOVERNANCE_PATH');
  }
  let real: string;
  try { real = realpathSync(candidate); } catch { return candidate; }
  const realRel = relative(root, real);
  if (realRel.startsWith('..') || isAbsolute(realRel)) denied('SANDBOX_SYMLINK_ESCAPE');
  return candidate;
}

/** Only read-only inspection commands are permitted inside the sandbox. */
export function assertSandboxCommand(command: string, args: readonly string[]): void {
  if (command === 'git') {
    const sub = String(args[0] ?? '');
    if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) denied('SANDBOX_GIT_WRITE_BLOCKED');
    return;
  }
  if (!ALLOWED_COMMANDS.has(command)) denied('SANDBOX_COMMAND_BLOCKED');
  for (const arg of args) {
    if (/(^|[^-])(--exec|--upload-pack|--receive-pack)/.test(String(arg))) denied('SANDBOX_COMMAND_BLOCKED');
  }
}

export function evaluateSandboxChanges(changes: Array<{ path: string }>, worktreePath: string): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const change of changes) {
    try {
      assertSandboxPath(worktreePath, change.path);
    } catch (error) {
      reasons.push(String((error as Error).message));
    }
  }
  return { allowed: reasons.length === 0, reasons };
}
