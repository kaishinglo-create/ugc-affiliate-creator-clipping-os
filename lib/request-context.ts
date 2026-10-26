import { readSessionCookie, verifySession, resolveMembership } from './auth.js';
import { json } from '../src/_shared.js';

export async function requireAuthAndWorkspace(req: any, res: any) {
  const cookie = readSessionCookie(req);
  const session = await verifySession(cookie);
  if (!session) {
    json(res, 401, { error: 'NOT_AUTHENTICATED' });
    return null;
  }
  const requestedWorkspaceId = req.headers['x-workspace-id'] || (req.url && new URL(req.url, 'http://internal').searchParams.get('workspaceId'));
  if (!requestedWorkspaceId) {
    json(res, 400, { error: 'WORKSPACE_ID_REQUIRED' });
    return null;
  }
  const membership = await resolveMembership(session.userId, requestedWorkspaceId);
  if (!membership) {
    json(res, 403, { error: 'NOT_A_WORKSPACE_MEMBER' });
    return null;
  }
  return { userId: session.userId, workspaceId: membership.workspaceId, role: membership.role };
}
