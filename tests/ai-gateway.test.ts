import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildServer } from '../src/index.js';
import { prisma, withWorkspaceTransaction } from '../lib/db.js';
import { agentMode, dailyRequestLimit, generateStructured, getAIStatus, isAIConfigured } from '../src/ai/gateway.js';
import { runAgentTask } from '../src/ai/agent-runtime.js';
import { getAgentSpec } from '../src/ai/agents.js';
import { resolveAgentModel } from '../src/ai/models.js';
import { AIConfigurationError, AIUpstreamError, AIUsageLimitError, AIValidationError } from '../src/ai/errors.js';
import type { AIProvider, AIRequest, AIResult } from '../src/ai/provider.js';

class FakeProvider implements AIProvider {
  readonly name = 'fake-provider';
  calls: AIRequest[] = [];

  constructor(private readonly responder: (request: AIRequest) => AIResult | Promise<AIResult>, public configured = true) {}

  async chat(request: AIRequest): Promise<AIResult> {
    this.calls.push(request);
    return this.responder(request);
  }
}

function result(content: string): AIResult {
  return {
    model: 'fake-model',
    content,
    usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  };
}

const VALID_RESEARCH = JSON.stringify({ summary: 'Validate demand first.', questions: ['Which niche converts?'], tools: ['read_analytics'] });

function researchInvocation(workspaceId: string, provider: AIProvider, overrides: Record<string, unknown> = {}) {
  const spec = getAgentSpec('research');
  return {
    workspaceId,
    agentKey: spec.key,
    departmentKey: 'research',
    action: 'research_market',
    goal: 'Launch a clipping campaign',
    systemPrompt: spec.systemPrompt,
    userPrompt: spec.buildUserPrompt({ action: 'research_market', goal: 'Launch a clipping campaign' }),
    schema: spec.schema,
    provider,
    ...overrides,
  };
}

async function aiAuditEvents(workspaceId: string): Promise<any[]> {
  return withWorkspaceTransaction(workspaceId, (tx: any) =>
    tx.auditEvent.findMany({ where: { workspaceId, type: 'ai_request' }, orderBy: { createdAt: 'asc' } }),
  );
}

describe('ai gateway', () => {
  let app: any;
  const originalKey = process.env.OLLAMA_API_KEY;
  const originalMode = process.env.AGENT_AI_MODE;
  const originalLimit = process.env.AI_MAX_DAILY_REQUESTS_PER_WORKSPACE;
  const originalOllamaLimit = process.env.OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE;
  const originalAgentModel = process.env.OLLAMA_MODEL_RESEARCH;

  beforeAll(async () => {
    app = await buildServer();
  });

  beforeEach(() => {
    delete process.env.OLLAMA_API_KEY;
    process.env.AGENT_AI_MODE = 'auto';
    process.env.AI_MAX_DAILY_REQUESTS_PER_WORKSPACE = '10';
    delete process.env.OLLAMA_MODEL_RESEARCH;
  });

  afterAll(async () => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('OLLAMA_API_KEY', originalKey);
    restore('AGENT_AI_MODE', originalMode);
    restore('AI_MAX_DAILY_REQUESTS_PER_WORKSPACE', originalLimit);
    restore('OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE', originalOllamaLimit);
    restore('OLLAMA_MODEL_RESEARCH', originalAgentModel);
    await app.close();
    await prisma.$disconnect();
  });

  async function workspace(): Promise<string> {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `ai-${suffix}@x.com`, password: 'password1234', workspaceName: 'AI', workspaceSlug: `ai-${suffix}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().workspace.id;
  }

  it('resolves a per-agent model with shared and default fallbacks', () => {
    expect(resolveAgentModel('research', { OLLAMA_MODEL: 'shared-model' } as any)).toBe('shared-model');
    expect(resolveAgentModel('research', { OLLAMA_MODEL: 'shared-model', OLLAMA_MODEL_RESEARCH: 'agent-model' } as any)).toBe('agent-model');
    expect(resolveAgentModel('creative', {} as any)).toBe('Base 1-flash');
  });

  it('parses agent mode and the daily request budget', () => {
    expect(agentMode({ AGENT_AI_MODE: 'required' } as any)).toBe('required');
    expect(agentMode({ AGENT_AI_MODE: 'off' } as any)).toBe('off');
    expect(agentMode({ AGENT_AI_MODE: 'nonsense' } as any)).toBe('auto');
    expect(dailyRequestLimit({ AI_MAX_DAILY_REQUESTS_PER_WORKSPACE: '7' } as any)).toBe(7);
    expect(dailyRequestLimit({ OLLAMA_MAX_DAILY_REQUESTS_PER_WORKSPACE: '9' } as any)).toBe(9);
    expect(dailyRequestLimit({ AI_MAX_DAILY_REQUESTS_PER_WORKSPACE: '0' } as any)).toBe(0);
    expect(dailyRequestLimit({} as any)).toBe(100);
  });

  it('accepts schema-valid structured output and records usage', async () => {
    const ws = await workspace();
    const provider = new FakeProvider(() => result(VALID_RESEARCH));

    const generated = await generateStructured(researchInvocation(ws, provider));

    expect(generated.data.summary).toBe('Validate demand first.');
    expect(generated.usage.totalTokens).toBe(18);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].responseFormat).toBe('json');
    expect(provider.calls[0].messages[0].role).toBe('system');

    const events = await aiAuditEvents(ws);
    expect(events).toHaveLength(1);
    expect(events[0].data.outcome).toBe('success');
    expect(events[0].data.agent).toBe('research');
    expect(events[0].data.totalTokens).toBe(18);
  });

  it('rejects non-JSON output without returning partial data', async () => {
    const ws = await workspace();
    const provider = new FakeProvider(() => result('Here is your plan: do great things.'));

    await expect(generateStructured(researchInvocation(ws, provider))).rejects.toBeInstanceOf(AIValidationError);
    const events = await aiAuditEvents(ws);
    expect(events).toHaveLength(1);
    expect(events[0].data.outcome).toBe('invalid_output');
    expect(events[0].data.errorCode).toBe('AI_OUTPUT_INVALID');
  });

  it('rejects JSON that does not match the agent schema', async () => {
    const ws = await workspace();
    const provider = new FakeProvider(() => result(JSON.stringify({ summary: 'Only a summary', unexpected: true })));

    await expect(generateStructured(researchInvocation(ws, provider))).rejects.toMatchObject({
      code: 'AI_OUTPUT_INVALID',
      details: { issues: expect.any(Array) },
    });
  });

  it('enforces the per-workspace daily request budget before calling a provider', async () => {
    process.env.AI_MAX_DAILY_REQUESTS_PER_WORKSPACE = '2';
    const ws = await workspace();
    await withWorkspaceTransaction(ws, async (tx: any) => {
      await tx.auditEvent.create({ data: { workspaceId: ws, type: 'ai_request', data: { outcome: 'success' } } });
      await tx.auditEvent.create({ data: { workspaceId: ws, type: 'ai_request', data: { outcome: 'success' } } });
    });
    const provider = new FakeProvider(() => result(VALID_RESEARCH));

    await expect(generateStructured(researchInvocation(ws, provider))).rejects.toBeInstanceOf(AIUsageLimitError);
    expect(provider.calls).toHaveLength(0);
  });

  it('reports AI as unconfigured without an API key and never invents a provider answer', async () => {
    const provider = new FakeProvider(() => result(VALID_RESEARCH), false);
    expect(isAIConfigured(provider)).toBe(false);
    const ws = await workspace();
    await expect(generateStructured(researchInvocation(ws, provider))).rejects.toBeInstanceOf(AIConfigurationError);
    expect(provider.calls).toHaveLength(0);
  });

  it('falls back to labelled deterministic planner output in auto mode', async () => {
    const ws = await workspace();
    const provider = new FakeProvider(() => result(VALID_RESEARCH), false);
    const output = await runAgentTask({
      workspaceId: ws,
      departmentKey: 'research',
      action: 'research_market',
      goal: 'Launch a clipping campaign',
      deterministic: () => ({ summary: 'Planner research', questions: ['q1'] }),
      provider,
    });
    expect(output._meta.source).toBe('deterministic_planner');
    expect(output.summary).toBe('Planner research');
    expect(provider.calls).toHaveLength(0);
  });

  it('fails visibly in required mode instead of degrading to the planner', async () => {
    process.env.AGENT_AI_MODE = 'required';
    const ws = await workspace();
    const provider = new FakeProvider(() => result(VALID_RESEARCH), false);
    await expect(runAgentTask({
      workspaceId: ws,
      departmentKey: 'research',
      action: 'research_market',
      goal: 'Launch a clipping campaign',
      deterministic: () => ({ summary: 'Planner research' }),
      provider,
    })).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(provider.calls).toHaveLength(0);
  });

  it('marks AI output and honours the per-agent model override', async () => {
    process.env.OLLAMA_MODEL_RESEARCH = 'research-model';
    const ws = await workspace();
    const provider = new FakeProvider(() => result(VALID_RESEARCH));
    const output = await runAgentTask({
      workspaceId: ws,
      departmentKey: 'research',
      action: 'research_market',
      goal: 'Launch a clipping campaign',
      deterministic: () => ({ summary: 'Planner research' }),
      provider,
    });
    expect(output._meta.source).toBe('ai');
    expect(output._meta.model).toBe('fake-model');
    expect(output.questions).toEqual(['Which niche converts?']);
    expect(provider.calls[0].model).toBe('research-model');
  });

  it('propagates upstream failures and records them as errors', async () => {
    const ws = await workspace();
    const provider = new FakeProvider(() => {
      throw new AIUpstreamError('AI_UPSTREAM_ERROR:503', { httpStatus: 503, retryable: true });
    });
    await expect(generateStructured(researchInvocation(ws, provider))).rejects.toMatchObject({
      code: 'AI_UPSTREAM_ERROR',
      retryable: true,
    });
    const events = await aiAuditEvents(ws);
    expect(events).toHaveLength(1);
    expect(events[0].data.outcome).toBe('error');
    expect(events[0].data.errorCode).toBe('AI_UPSTREAM_ERROR');
  });

  it('exposes gateway status without leaking credentials', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `ai-status-${suffix}@x.com`, password: 'password1234', workspaceName: 'AIS', workspaceSlug: `ais-${suffix}` },
    });
    expect(signup.statusCode).toBe(201);
    const ws = signup.json().workspace.id;
    const cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `ai-status-${suffix}@x.com`, password: 'password1234' } })).headers['set-cookie'];

    const anonymous = await app.inject({ method: 'GET', url: '/api/ai/status', headers: { 'x-workspace-id': ws } });
    expect(anonymous.statusCode).toBe(401);

    const res = await app.inject({ method: 'GET', url: '/api/ai/status', headers: { cookie, 'x-workspace-id': ws } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.provider).toBe('ollama-cloud');
    expect(body.agents).toHaveLength(10);
    expect(body.agents.every((agent: any) => typeof agent.model === 'string')).toBe(true);
    expect(JSON.stringify(body).toLowerCase()).not.toContain('apikey');
  });

  it('fails orchestration visibly when AI is required but not configured', async () => {
    process.env.AGENT_AI_MODE = 'required';
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `ai-or-${suffix}@x.com`, password: 'password1234', workspaceName: 'AIOR', workspaceSlug: `aior-${suffix}` },
    });
    expect(signup.statusCode).toBe(201);
    const ws = signup.json().workspace.id;
    const cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `ai-or-${suffix}@x.com`, password: 'password1234' } })).headers['set-cookie'];

    const run = await app.inject({
      method: 'POST',
      url: '/api/orchestrations',
      headers: { cookie, 'x-workspace-id': ws },
      payload: { goal: 'Create a clipping campaign' },
    });
    expect(run.statusCode).toBe(201);
    const orchestration = run.json().orchestration;
    expect(orchestration.status).toBe('failed');
    expect(String(orchestration.error)).toContain('AI_NOT_CONFIGURED');
    const succeeded = (orchestration.tasks || []).filter((task: any) => task.status === 'succeeded');
    expect(succeeded).toHaveLength(0);

    await withWorkspaceTransaction(ws, (tx: any) => tx.job.deleteMany({ where: { workspaceId: ws } }));
    await withWorkspaceTransaction(ws, (tx: any) => tx.orchestrationRun.deleteMany({ where: { workspaceId: ws } }));
  });

  it('reports status through the gateway helper', async () => {
    const ws = await workspace();
    const status = await getAIStatus(ws);
    expect(status.budget.limit).toBe(10);
    expect(status.budget.used).toBe(0);
    expect(status.mode).toBe('auto');
  });
});
