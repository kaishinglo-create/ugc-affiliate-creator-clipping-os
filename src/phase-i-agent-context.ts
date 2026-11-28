/**
 * Phase I.5: real workspace context for the existing CEO/COO/department agents.
 * No new agent runtime and no duplicate hierarchy — this only enriches the
 * deterministic outputs used when no AI provider is configured.
 */
import { withWorkspaceTransaction } from '../lib/db.js';

const count = async (tx: any, model: string, where: Record<string, unknown>) => {
  try { return await tx[model].count({ where }); } catch { return null; }
};

export async function phaseIAgentContext(workspaceId: string, role: string): Promise<Record<string, unknown>> {
  return withWorkspaceTransaction(workspaceId, async (tx: any) => {
    const base = { phaseIContextSource: 'phase_i_workspace_rows', externalLiveVerified: false };
    const [openIncidents, criticalIncidents, recoveryRuns, improvements, sandboxes] = await Promise.all([
      count(tx, 'incident', { workspaceId, status: 'open' }),
      count(tx, 'incident', { workspaceId, status: 'open', severity: 'critical' }),
      count(tx, 'recoveryRun', { workspaceId }),
      count(tx, 'improvementTask', { workspaceId, status: { in: ['proposed', 'prioritized'] } }),
      count(tx, 'sandboxRun', { workspaceId }),
    ]);
    switch (role) {
      case 'security':
        return { ...base, openIncidents, criticalIncidents, recoveryRuns };
      case 'qa':
        return { ...base, recoveryRuns, sandboxes };
      case 'coo':
      case 'ceo':
        return { ...base, openIncidents, recoveryRuns, improvements };
      case 'analytics':
      case 'growth':
        return { ...base, improvements, sandboxes };
      case 'api_integration':
        return { ...base, sandboxes, improvements };
      default:
        return { ...base, openIncidents, recoveryRuns, improvements, sandboxes };
    }
  });
}
