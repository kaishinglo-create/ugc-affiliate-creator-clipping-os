export type AIGatewayErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_BUDGET_DISABLED'
  | 'AI_BUDGET_EXCEEDED'
  | 'AI_TIMEOUT'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_OUTPUT_INVALID';

export class AIGatewayError extends Error {
  readonly code: AIGatewayErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: AIGatewayErrorCode, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'AIGatewayError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * Raised when the gateway cannot run because it is not configured (missing API
 * key, disabled budget, invalid configuration). Never fall back to a fabricated
 * answer — the caller must degrade visibly or fail the task.
 */
export class AIConfigurationError extends AIGatewayError {
  constructor(message = 'AI_NOT_CONFIGURED', details?: unknown) {
    super('AI_NOT_CONFIGURED', message, { retryable: false, details });
    this.name = 'AIConfigurationError';
  }
}

export class AIUsageLimitError extends AIGatewayError {
  constructor(message = 'AI_BUDGET_EXCEEDED', details?: unknown) {
    super('AI_BUDGET_EXCEEDED', message, { retryable: false, details });
    this.name = 'AIUsageLimitError';
  }
}

/** The provider answered, but the answer was not valid JSON matching the agent schema. */
export class AIValidationError extends AIGatewayError {
  constructor(details?: unknown) {
    super('AI_OUTPUT_INVALID', 'AI_OUTPUT_INVALID', { retryable: true, details });
    this.name = 'AIValidationError';
  }
}

export class AIUpstreamError extends AIGatewayError {
  readonly httpStatus: number | null;

  constructor(
    message: string,
    options: { httpStatus?: number | null; retryable?: boolean; details?: unknown; code?: 'AI_TIMEOUT' | 'AI_UPSTREAM_ERROR' } = {},
  ) {
    const code = options.code ?? 'AI_UPSTREAM_ERROR';
    super(code, message, { retryable: options.retryable ?? false, details: options.details });
    this.name = 'AIUpstreamError';
    this.httpStatus = options.httpStatus ?? null;
  }
}

export function isAIGatewayError(error: unknown): error is AIGatewayError {
  return error instanceof AIGatewayError;
}
