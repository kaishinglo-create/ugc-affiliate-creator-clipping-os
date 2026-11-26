/**
 * Temporary, env-gated runtime diagnostics for Phase E.1.
 *
 * Nothing is written unless QA_TRACE_FILE is set. No credential values,
 * lease tokens or session data are logged; only IDs, states and timings.
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const FILE = process.env.QA_TRACE_FILE?.trim();

function activeResources(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const info = (process as any).getActiveResourcesInfo?.() as string[] | undefined;
    for (const type of info ?? []) out[type] = (out[type] ?? 0) + 1;
  } catch {
    // Diagnostics must never change runtime behaviour.
  }
  return out;
}

export function trace(event: string, fields: Record<string, unknown> = {}): void {
  if (!FILE) return;
  try {
    appendFileSync(FILE, `${JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      span: fields.span ?? null,
      event,
      ...fields,
      active: activeResources(),
    })}\n`);
  } catch {
    // Diagnostics must never change runtime behaviour.
  }
}

export function newSpan(): string {
  return randomUUID().slice(0, 8);
}

export async function traced<T>(
  event: string,
  fields: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const span = String(fields.span ?? newSpan());
  trace(`${event}.start`, { ...fields, span });
  try {
    const result = await work();
    trace(`${event}.end`, { ...fields, span, durationMs: Date.now() - started, ok: true });
    return result;
  } catch (error) {
    trace(`${event}.error`, {
      ...fields,
      span,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
    throw error;
  }
}
