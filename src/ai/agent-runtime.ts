import { getAgentSpec } from './agents.js';
import { agentMode, defaultProvider, generateStructured, isAIConfigured } from './gateway.js';
import { AIConfigurationError } from './errors.js';
import type { AIProvider } from './provider.js';

export type AgentOutputSource = 'ai' | 'deterministic_planner';

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
}

export function markDeterministicOutput(output: any): any {
  return {
    ...output,
    _meta: { source: 'deterministic_planner', provider: 'none', model: null, latencyMs: 0, usage: null } satisfies AgentOutputMeta,
  };
}

/**
 * Runs one departmental agent task through the AI gateway when configured.
 * - `AGENT_AI_MODE=auto` (default): AI when configured and within budget, otherwise the
 *   deterministic planner output, explicitly marked as such.
 * - `AGENT_AI_MODE=off`: never calls AI.
 * - `AGENT_AI_MODE=required`: throws AIConfigurationError when AI is unavailable, so a task
 *   fails visibly instead of silently degrading.
 * AI errors always propagate (the orchestration worker records the failure and retries only
 * when the gateway marks it retryable).
 */
export async function runAgentTask(input: AgentTaskInput): Promise<any> {
  const mode = agentMode();
  if (mode === 'off') return markDeterministicOutput(input.deterministic());

  const provider = input.provider ?? defaultProvider();
  if (!isAIConfigured(provider)) {
    if (mode === 'required') {
      throw new AIConfigurationError('AI_NOT_CONFIGURED', { department: input.departmentKey, mode });
    }
    return markDeterministicOutput(input.deterministic());
  }

  const spec = getAgentSpec(input.departmentKey);
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
    } satisfies AgentOutputMeta,
  };
}
