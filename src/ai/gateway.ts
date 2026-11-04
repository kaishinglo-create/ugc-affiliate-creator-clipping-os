import { z } from 'zod';
import { withWorkspaceTransaction } from '../../lib/db.js';
import { writeAuditEvent } from '../../lib/audit.js';
import { AGENT_KEYS } from './agents.js';
import { AIConfigurationError, AIGatewayError, AIUsageLimitError, AIValidationError } from './errors.js';
import { resolveAgentModel } from './models.js';
import { OllamaCloudProvider, type AIProvider, type AIUsage } from './provider.js';

export type AgentAIMode = 'auto' | 'off' | 'required';

const DEFAULT_DAILY_REQUEST_LIMIT = 100;
const AUDIT_TYPE = 'ai_request';

/** `auto`: use AI when configured, mark deterministic output otherwise. `required`: fail instead of falling back. */
export function agentMode(env: NodeJS.ProcessEnv = process.env): AgentAIMode {
  const raw = String(env.AGENT_AI_MODE ?? 'auto').trim().toLowerCase();
  return raw === 'off' || raw === 'required' ? raw : 'auto';
}

/** Per-workspace daily cap, shared default with the existing Ollama chat budget. 0 disables AI. */
export function dailyRequestLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_MAX_DAILY_REQUESTS_PER_WORKSPACE ?? env.OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_DAILY_REQUEST_LIMIT;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function defaultProvider(): AIProvider {
  return new OllamaCloudProvider();
}

export function isAIConfigured(provider: AIProvider = defaultProvider()): boolean {
  return provider.configured && dailyRequestLimit() > 0;
}

function startOfUtcDay(): Date {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

async function countTodayRequests(workspaceId: string): Promise<number> {
  return withWorkspaceTransaction(workspaceId, (tx) =>
    tx.auditEvent.count({ where: { workspaceId, type: AUDIT_TYPE, createdAt: { gte: startOfUtcDay() } } }),
  );
}

async function assertWithinBudget(workspaceId: string): Promise<void> {
  const limit = dailyRequestLimit();
  if (limit <= 0) throw new AIConfigurationError('AI_BUDGET_DISABLED', { limit });
  const used = await countTodayRequests(workspaceId);
  if (used >= limit) throw new AIUsageLimitError('AI_BUDGET_EXCEEDED', { used, limit });
}

export interface AIUsageContext {
  workspaceId: string;
  agentKey: string;
  departmentKey: string;
  action: string;
  goalLength: number;
}

function parseJsonObject(content: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'NOT_A_JSON_OBJECT' };
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }
}

/** Best effort: usage accounting must never mask the real AI error. */
async function recordUsage(
  context: AIUsageContext,
  data: {
    provider: string;
    model: string | null;
    latencyMs: number;
    outcome: 'success' | 'error' | 'invalid_output';
    errorCode: string | null;
  },
  usage: AIUsage | null,
): Promise<void> {
  try {
    await withWorkspaceTransaction(context.workspaceId, (tx) =>
      writeAuditEvent({
        workspaceId: context.workspaceId,
        type: AUDIT_TYPE,
        actor: null,
        tx,
        data: {
          agent: context.agentKey,
          department: context.departmentKey,
          action: context.action,
          provider: data.provider,
          model: data.model,
          latencyMs: data.latencyMs,
          outcome: data.outcome,
          errorCode: data.errorCode,
          goalLength: context.goalLength,
          promptTokens: usage?.promptTokens ?? null,
          completionTokens: usage?.completionTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
        },
      }),
    );
  } catch {
    // Deliberately ignored: accounting is not allowed to change the AI outcome.
  }
}

export interface GenerateStructuredInput<T> {
  workspaceId: string;
  agentKey: string;
  departmentKey: string;
  action: string;
  goal: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  provider?: AIProvider;
}

export interface GeneratedStructured<T> {
  data: T;
  model: string;
  provider: string;
  usage: AIUsage;
  latencyMs: number;
}

/**
 * Single entry point for structured agent generations: configuration check,
 * per-workspace budget, provider call, JSON parsing, Zod validation and usage
 * accounting. Throws AIGatewayError subclasses; never returns a fabricated
 * answer on failure.
 */
export async function generateStructured<T>(input: GenerateStructuredInput<T>): Promise<GeneratedStructured<T>> {
  const provider = input.provider ?? defaultProvider();
  if (!provider.configured) throw new AIConfigurationError('AI_NOT_CONFIGURED', { provider: provider.name });

  const model = input.model?.trim() || resolveAgentModel(input.agentKey);
  await assertWithinBudget(input.workspaceId);

  const usageContext: AIUsageContext = {
    workspaceId: input.workspaceId,
    agentKey: input.agentKey,
    departmentKey: input.departmentKey,
    action: input.action,
    goalLength: input.goal.length,
  };

  const startedAt = Date.now();
  let result;
  try {
    result = await provider.chat({
      model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      responseFormat: 'json',
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const code = error instanceof AIGatewayError ? error.code : 'AI_UPSTREAM_ERROR';
    await recordUsage(usageContext, { provider: provider.name, model, latencyMs: Date.now() - startedAt, outcome: 'error', errorCode: code }, null);
    throw error;
  }

  const latencyMs = Date.now() - startedAt;
  const parsed = parseJsonObject(result.content);
  if (!parsed.ok) {
    const error = new AIValidationError({ reason: parsed.reason });
    await recordUsage(usageContext, { provider: provider.name, model: result.model, latencyMs, outcome: 'invalid_output', errorCode: error.code }, result.usage);
    throw error;
  }

  const validated = input.schema.safeParse(parsed.value);
  if (!validated.success) {
    const error = new AIValidationError({
      issues: validated.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    await recordUsage(usageContext, { provider: provider.name, model: result.model, latencyMs, outcome: 'invalid_output', errorCode: error.code }, result.usage);
    throw error;
  }

  await recordUsage(usageContext, { provider: provider.name, model: result.model, latencyMs, outcome: 'success', errorCode: null }, result.usage);
  return { data: validated.data as T, model: result.model, provider: provider.name, usage: result.usage, latencyMs };
}

export interface AIStatus {
  provider: string;
  configured: boolean;
  mode: AgentAIMode;
  budget: { limit: number; used: number; remaining: number; window: 'utc_day' };
  agents: { agentKey: string; departmentKey: string; model: string }[];
}

export async function getAIStatus(workspaceId: string): Promise<AIStatus> {
  const provider = defaultProvider();
  const limit = dailyRequestLimit();
  const used = await countTodayRequests(workspaceId);
  return {
    provider: provider.name,
    configured: provider.configured && limit > 0,
    mode: agentMode(),
    budget: { limit, used, remaining: Math.max(0, limit - used), window: 'utc_day' },
    agents: AGENT_KEYS.map((key) => ({ agentKey: key, departmentKey: key, model: resolveAgentModel(key) })),
  };
}
