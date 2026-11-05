export const DEFAULT_OLLAMA_MODEL = 'Base 1-flash';

/**
 * Per-agent model resolution. `OLLAMA_MODEL_<AGENT>` wins, then the shared
 * `OLLAMA_MODEL`, then the repository default. No model capability is assumed:
 * only configured names are used.
 */
export function resolveAgentModel(agentKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const perAgent = env[`OLLAMA_MODEL_${agentKey.toUpperCase()}`]?.trim();
  if (perAgent) return perAgent;
  return env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
}
