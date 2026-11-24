import { getAgentSpec } from './agents.js';
import { agentMode, defaultProvider, generateStructured, isAIConfigured } from './gateway.js';
import { AIConfigurationError, AIUsageLimitError } from './errors.js';
import type { AIProvider } from './provider.js';

export type AgentOutputSource = 'ai' | 'deterministic_planner';
export type AgentFallbackReason = 'mode_off' | 'ai_unconfigured' | 'budget_exhausted';

export interface AgentTaskInput {
  workspaceId: string;
  departmentKey: string;
  action: string;
  goal: string;
  timeoutMs?: number;
  /** Deterministic plan used only when AI is not available (auto/off mode). Always labelled. */
  deterministic: () => any;
  provider?: AIProvider;
}

export interface AgentOutputMeta {
  source: AgentOutputSource;
  provider: string;
  model: string | null;
  latencyMs: number;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  /** Why the deterministic planner was used; `null` when a provider produced the output. */
  fallbackReason: AgentFallbackReason | null;
}

export function markDeterministicOutput(output: any, fallbackReason: AgentFallbackReason): any {
  return {
    ...output,
    _meta: {
      source: 'deterministic_planner',
      provider: 'none',
      model: null,
      latencyMs: 0,
      usage: null,
      fallbackReason,
    } satisfies AgentOutputMeta,
  };
}

/**
 * Runs one departmental agent task through the AI gateway when configured.
 * - `AGENT_AI_MODE=auto` (default): AI when configured and within budget, otherwise the
 *   deterministic planner output, explicitly marked as such.
 * - `AGENT_AI_MODE=off`: never calls AI.
 * - `AGENT_AI_MODE=required`: throws AIConfigurationError when AI is unavailable, so a task
 *   fails visibly instead of silently degrading.
 * Provider/validation/upstream errors always propagate (the orchestration worker records the
 * failure and retries only when the gateway marks it retryable). Budget exhaustion is also
 * enforced by the gateway; in auto mode the task then degrades to labelled planner output.
 */
export async function runAgentTask(input: AgentTaskInput): Promise<any> {
  const mode = agentMode();
  if (mode === 'off') return markDeterministicOutput(input.deterministic(), 'mode_off');

  const provider = input.provider ?? defaultProvider();
  if (!isAIConfigured(provider)) {
    if (mode === 'required') {
      throw new AIConfigurationError('AI_NOT_CONFIGURED', { department: input.departmentKey, mode });
    }
    return markDeterministicOutput(input.deterministic(), 'ai_unconfigured');
  }

  const spec = getAgentSpec(input.departmentKey);
  try {
    const generated = await generateStructured({
      workspaceId: input.workspaceId,
      agentKey: spec.key,
      departmentKey: input.departmentKey,
      action: input.action,
      goal: input.goal,
      systemPrompt: spec.systemPrompt,
      userPrompt: spec.buildUserPrompt({ action: input.action, goal: input.goal }),
      schema: spec.schema,
      timeoutMs: input.timeoutMs,
      provider,
    });

    return {
      ...generated.data,
      _meta: {
        source: 'ai',
        provider: generated.provider,
        model: generated.model,
        latencyMs: generated.latencyMs,
        usage: generated.usage,
        fallbackReason: null,
      } satisfies AgentOutputMeta,
    };
  } catch (error) {
    // The gateway reserves the daily budget atomically and throws before any
    // provider call. In auto mode a task degrades visibly to the planner (the
    // output stays labelled); required mode and upstream failures still fail.
    if (mode === 'auto' && (error instanceof AIUsageLimitError || error instanceof AIConfigurationError)) {
      return markDeterministicOutput(
        input.deterministic(),
        error instanceof AIUsageLimitError ? 'budget_exhausted' : 'ai_unconfigured',
      );
    }
    throw error;
  }
}
