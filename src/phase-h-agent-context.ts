/**
 * Phase H agent backend context.
 *
 * Department outputs stay honest deterministic planner output (no AI key is
 * configured locally), but every factual number now comes from persisted
 * workspace rows. No value is invented and no external call is made.
 */
import { withWorkspaceTransaction } from '../lib/db.js';

export type PhaseHAgentRole =
  | 'publishing' | 'affiliate' | 'growth' | 'analytics' | 'api_integration'
  | 'research' | 'security' | 'ceo' | 'coo';

const count = async (tx: any, model: string, where: Record<string, unknown>) => {
  try {
    return await tx[model].count({ where });
  } catch {
    return null;
  }
};

export async function phaseHAgentContext(
  workspaceId: string,
  role: string,
): Promise<Record<string, unknown>> {
  return withWorkspaceTransaction(workspaceId, async (tx: any) => {
    const base: Record<string, unknown> = {
      contextSource: 'workspace_rows',
      externalLiveVerified: false,
    };
    switch (role) {
      case 'publishing': {
        const [queued, running, deadLetter, accounts, schedules, approvals] = await Promise.all([
          count(tx, 'job', { workspaceId, status: 'QUEUED' }),
          count(tx, 'job', { workspaceId, status: 'RUNNING' }),
          count(tx, 'job', { workspaceId, status: 'DEAD_LETTER' }),
          count(tx, 'publishingAccount', { workspaceId }),
          count(tx, 'publishingSchedule', { workspaceId }),
          count(tx, 'approval', { workspaceId, status: 'pending', entityType: 'publishing' }),
        ]);
        return { ...base, queuedJobs: queued, runningJobs: running, deadLetterJobs: deadLetter, publishingAccounts: accounts, publishingSchedules: schedules, pendingApprovals: approvals };
      }
      case 'affiliate':
      case 'growth': {
        const [links, clicks, conversions, paid] = await Promise.all([
          count(tx, 'affiliateLink', { workspaceId }),
          count(tx, 'affiliateClick', { workspaceId }),
          count(tx, 'affiliateConversion', { workspaceId }),
          count(tx, 'affiliateConversion', { workspaceId, status: 'paid' }),
        ]);
        return { ...base, affiliateLinks: links, clicks, conversions, paidConversions: paid };
      }
      case 'analytics': {
        const [snapshots, clicks, conversions, posts] = await Promise.all([
          count(tx, 'analyticsSnapshot', { workspaceId }),
          count(tx, 'affiliateClick', { workspaceId }),
          count(tx, 'affiliateConversion', { workspaceId }),
          count(tx, 'contentPost', { workspaceId }),
        ]);
        return { ...base, analyticsSnapshots: snapshots, recordedClicks: clicks, recordedConversions: conversions, contentPosts: posts };
      }
      case 'api_integration': {
        const [credentials, connections, events] = await Promise.all([
          count(tx, 'apiCredential', { workspaceId }),
          count(tx, 'apiConnection', { workspaceId }),
          count(tx, 'apiIntegrationEvent', { workspaceId }),
        ]);
        return { ...base, storedCredentials: credentials, connections, integrationEvents: events };
      }
      case 'research': {
        const [candidates, reports] = await Promise.all([
          count(tx, 'discoveryCandidate', { workspaceId }),
          count(tx, 'researchReport', { workspaceId }),
        ]);
        return { ...base, discoveryCandidates: candidates, researchReports: reports };
      }
      case 'security': {
        const [killSwitch, approvals, auditEvents] = await Promise.all([
          count(tx, 'killSwitch', { workspaceId, active: true }),
          count(tx, 'approval', { workspaceId, status: 'pending' }),
          count(tx, 'auditEvent', { workspaceId }),
        ]);
        return { ...base, killSwitchActive: killSwitch, pendingApprovals: approvals, auditEvents };
      }
      case 'ceo':
      case 'coo': {
        const [tasks, delegations, incidents] = await Promise.all([
          count(tx, 'orchestrationTask', { workspaceId }),
          count(tx, 'delegationRecord', { workspaceId }),
          count(tx, 'incident', { workspaceId }),
        ]);
        return { ...base, orchestrationTasks: tasks, delegations, incidents };
      }
      default:
        return base;
    }
  });
}
