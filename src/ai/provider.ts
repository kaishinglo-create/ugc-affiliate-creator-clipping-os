import { AIConfigurationError, AIUpstreamError } from './errors.js';

export type AITaskRole = 'system' | 'user' | 'assistant';

export interface AIMessage {
  role: AITaskRole;
  content: string;
}

export interface AIRequest {
  model: string;
  messages: AIMessage[];
  temperature?: number;
  responseFormat?: 'json' | 'text';
  timeoutMs?: number;
}

export interface AIUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface AIResult {
  model: string;
  content: string;
  usage: AIUsage;
}

/** Provider-independent contract. A provider either answers or throws an AIGatewayError. */
export interface AIProvider {
  readonly name: string;
  readonly configured: boolean;
  chat(request: AIRequest): Promise<AIResult>;
}

export const OLLAMA_DEFAULT_BASE_URL = 'https://ollama.com';
const DEFAULT_TIMEOUT_MS = 30000;

export interface OllamaProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Ollama Cloud (`/api/chat`, non-streaming). Reads OLLAMA_API_KEY server-side only. */
export class OllamaCloudProvider implements AIProvider {
  readonly name = 'ollama-cloud';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions = {}) {
    this.apiKey = String(options.apiKey ?? process.env.OLLAMA_API_KEY ?? '').trim();
    this.baseUrl = String(options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async chat(request: AIRequest): Promise<AIResult> {
    if (!this.configured) throw new AIConfigurationError('AI_NOT_CONFIGURED', { provider: this.name });

    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? Math.min(request.timeoutMs, 120000) : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          stream: false,
          ...(request.responseFormat === 'json' ? { format: 'json' } : {}),
          ...(request.temperature !== undefined ? { options: { temperature: request.temperature } } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.text().catch(() => undefined);
        throw new AIUpstreamError(`AI_UPSTREAM_ERROR:${response.status}`, {
          httpStatus: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      let data: any;
      try {
        data = await response.json();
      } catch {
        throw new AIUpstreamError('AI_UPSTREAM_ERROR:INVALID_RESPONSE', { httpStatus: response.status, retryable: true });
      }

      const content = typeof data?.message?.content === 'string' ? data.message.content : '';
      if (!content.trim()) {
        throw new AIUpstreamError('AI_UPSTREAM_ERROR:EMPTY_RESPONSE', { httpStatus: response.status, retryable: true });
      }

      const promptTokens = Number.isFinite(data?.prompt_eval_count) ? Number(data.prompt_eval_count) : null;
      const completionTokens = Number.isFinite(data?.eval_count) ? Number(data.eval_count) : null;
      return {
        model: typeof data?.model === 'string' && data.model ? data.model : request.model,
        content,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null,
        },
      };
    } catch (error) {
      if (error instanceof AIConfigurationError || error instanceof AIUpstreamError) throw error;
      if ((error as Error)?.name === 'AbortError') {
        throw new AIUpstreamError('AI_TIMEOUT', { code: 'AI_TIMEOUT', retryable: true });
      }
      throw new AIUpstreamError('AI_UPSTREAM_ERROR', { retryable: true, details: (error as Error)?.message ?? null });
    } finally {
      clearTimeout(timer);
    }
  }
}
