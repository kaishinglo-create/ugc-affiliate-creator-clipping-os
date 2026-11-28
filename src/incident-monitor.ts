/**
 * Phase I.1: read-only health signals and persistent incident management.
 *
 * Every signal is observed, classified and stored with evidence. This module
 * never terminates a process, cancels a foreign transaction or mutates a
 * service; remediation belongs to the approval-gated recovery engine.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withWorkspaceTransaction } from '../lib/db.js';
import { writeAuditEvent } from '../lib/audit.js';
import { prisma } from '../lib/db.js';

export type Severity = 'info' | 'warning' | 'error' | 'critical';
export type IncidentStatus = 'open' | 'diagnosed' | 'planned' | 'approved' | 'executing' | 'resolved' | 'unresolved';

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export interface HealthSignal {
  kind: string;
  healthy: boolean;
  severity: Severity;
  details: Record<string, unknown>;
}

/** Read-only TCP listener inventory (no process mutation). */
export function inspectPorts(ports: number[]): HealthSignal[] {
  let output = '';
  try {
    output = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return [{ kind: 'port_scan', healthy: false, severity: 'warning', details: { reason: 'SS_UNAVAILABLE' } }];
  }
  return ports.map((port) => {
    const line = output.split('\n').find((entry) => entry.includes(`:${port} `) || entry.trim().endsWith(`:${port}`));
    const owner = line && /pid=(\d+)/.exec(line);
    return {
      kind: `port_${port}`,
      healthy: Boolean(line),
      severity: line ? 'info' : 'warning',
      details: { port, listening: Boolean(line), ownerPid: owner ? Number(owner[1]) : null },
    };
  });
}

/** Read-only process inventory; never identifies a secret or command line value. */
export function inspectProcesses(patterns: string[]): HealthSignal {
  let output = '';
  try {
    output = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5_000 });
  } catch {
    return { kind: 'process_scan', healthy: false, severity: 'warning', details: { reason: 'PS_UNAVAILABLE' } };
  }
  const matches = output.split('\n').map((line) => line.trim().split(/\s+/)).filter((parts) =>
    parts.length >= 3 && patterns.some((pattern) => (parts[2] ?? '').includes(pattern)));
  return {
    kind: 'process_scan',
    healthy: true,
    severity: matches.length > 0 ? 'info' : 'warning',
    details: { observed: matches.length, patternCount: patterns.length },
  };
}

/** Read-only detection of long-running idle transactions owned by this app role. */
export async function inspectDatabase(): Promise<HealthSignal> {
  try {
    const rows: any[] = await prisma.$queryRaw`
      select pid, state, extract(epoch from (now() - state_change))::int as seconds
      from pg_stat_activity
      where datname = current_database() and state = 'idle in transaction'
    `;
    const stuck = rows.filter((row) => Number(row.seconds) > 120);
    return {
      kind: 'database_transactions',
      healthy: stuck.length === 0,
      severity: stuck.length ? 'error' : 'info',
      details: { idleInTransaction: rows.length, stuckCount: stuck.length, pids: stuck.map((row) => Number(row.pid)) },
    };
  } catch {
    return { kind: 'database_transactions', healthy: false, severity: 'error', details: { reason: 'DB_PROBE_FAILED' } };
  }
}

/** Freeze manifest hash verification (INC-PH-05). */
export function inspectFreeze(manifestPath: string): HealthSignal {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const actual = createHash('sha256').update(JSON.stringify(files.map((entry: any) => ({
      file: entry.file,
      sha256: createHash('sha256').update(readFileSync(entry.file)).digest('hex'),
    })))).digest('hex');
    return {
      kind: 'source_freeze',
      healthy: actual === manifest.overall,
      severity: actual === manifest.overall ? 'info' : 'critical',
      details: { manifest: manifestPath, drift: actual !== manifest.overall },
    };
  } catch {
    return { kind: 'source_freeze', healthy: false, severity: 'warning', details: { reason: 'MANIFEST_UNAVAILABLE' } };
  }
}

function fingerprintOf(kind: string, details: Record<string, unknown>): string {
  const stable = JSON.stringify(details, Object.keys(details).sort());
  return `${kind}:${createHash('sha256').update(stable).digest('hex').slice(0, 24)}`;
}

export async function recordIncident(input: {
  workspaceId: string;
  kind: string;
  severity: Severity;
  evidence: Record<string, unknown>;
  actor?: string | null;
}): Promise<{ incident: any; deduplicated: boolean }> {
  const fingerprint = fingerprintOf(input.kind, input.evidence);
  return withWorkspaceTransaction(input.workspaceId, async (tx: any) => {
    const open: any = await tx.incident.findFirst({
      where: { workspaceId: input.workspaceId, fingerprint, status: 'open' },
    });
    if (open) return { incident: open, deduplicated: true };
    const incident: any = await tx.incident.create({
      data: {
        workspaceId: input.workspaceId,
        title: String(input.kind).slice(0, 300),
        signature: fingerprint,
        fingerprint,
        kind: input.kind,
        severity: input.severity,
        evidence: input.evidence,
        details: JSON.stringify(input.evidence).slice(0, 2000),
      },
    });
    await writeAuditEvent({
      tx,
      workspaceId: input.workspaceId,
      userId: input.actor ?? null,
      runId: null,
      type: 'incident_detected',
      actor: input.actor ?? 'monitor',
      data: { incidentId: incident.id, kind: input.kind, severity: input.severity, fingerprint },
    });
    return { incident, deduplicated: false };
  });
}

export async function listIncidents(workspaceId: string, status?: IncidentStatus, take = 100): Promise<any[]> {
  return withWorkspaceTransaction<any[]>(workspaceId, (tx: any) => tx.incident.findMany({
    where: { workspaceId, ...(status ? { status } : {}) },
    orderBy: { detectedAt: 'desc' },
    take: Math.min(500, Math.max(1, take)),
  }));
}

export async function diagnoseIncident(workspaceId: string, incidentId: string, diagnosis: Record<string, unknown>): Promise<any | null> {
  return withWorkspaceTransaction<any>(workspaceId, async (tx: any) => {
    const row: any = await tx.incident.findFirst({ where: { id: incidentId, workspaceId } });
    if (!row) return null;
    const updated: any = await tx.incident.update({
      where: { id: incidentId },
      data: { status: 'diagnosed', diagnosis },
    });
    await writeAuditEvent({
      tx, workspaceId, userId: null, runId: null, type: 'incident_diagnosed', actor: 'monitor',
      data: { incidentId, kind: row.kind, classification: diagnosis.classification ?? 'unknown' },
    });
    return updated;
  });
}

export async function resolveIncident(workspaceId: string, incidentId: string, resolved: boolean, actor: string | null = null): Promise<any | null> {
  return withWorkspaceTransaction<any>(workspaceId, async (tx: any) => {
    const row: any = await tx.incident.findFirst({ where: { id: incidentId, workspaceId } });
    if (!row) return null;
    const updated: any = await tx.incident.update({
      where: { id: incidentId },
      data: { status: resolved ? 'resolved' : 'unresolved', resolvedAt: new Date() },
    });
    await writeAuditEvent({
      tx, workspaceId, userId: actor, runId: null, type: resolved ? 'incident_resolved' : 'incident_unresolved',
      actor: actor ?? 'recovery', data: { incidentId, kind: row.kind },
    });
    return updated;
  });
}

export function higherSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
