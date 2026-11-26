import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { departmentProduces } from '../src/orchestration.js';
import { runAgentTask } from '../src/ai/agent-runtime.js';

describe('deterministic agent outputs', () => {
  it('does not claim approval, publishing, enforcement or readiness it cannot verify', async () => {
    const qa = departmentProduces('qa', 'qa_review', 'goal');
    expect(qa.passed).toBeNull();
    expect(qa.approvedFor).toBe('manual_review_required');

    const publishing = departmentProduces('publishing', 'plan_publication', 'goal');
    expect(publishing.status).toBe('planned_only');
    expect(publishing.plannedPosts).toBeNull();

    const security = departmentProduces('security', 'review_controls', 'goal');
    expect(security.killSwitchRespected).toBeNull();
    expect(security.verification).toBe('not_verified_by_planner');

    const ceo = departmentProduces('ceo', 'synthesize', 'goal');
    expect(ceo.dependenciesResolved).toBeNull();
    expect(ceo.status).toBe('awaiting_validation');

    const originalMode = process.env.AGENT_AI_MODE;
    process.env.AGENT_AI_MODE = 'off';
    try {
      const output = await runAgentTask({
        workspaceId: 'unit-test',
        departmentKey: 'qa',
        action: 'qa_review',
        goal: 'goal',
        deterministic: () => departmentProduces('qa', 'qa_review', 'goal'),
      });
      expect(output._meta.source).toBe('deterministic_planner');
      expect(output._meta.fallbackReason).toBe('mode_off');
      expect(output.passed).toBeNull();
    } finally {
      if (originalMode === undefined) delete process.env.AGENT_AI_MODE;
      else process.env.AGENT_AI_MODE = originalMode;
    }
  });
});
