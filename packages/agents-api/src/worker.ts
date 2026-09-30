import type { AgentSession, ApiEvent, QueueDecision } from './types.js';
import { queueDecision } from './types.js';

export interface EnvironmentWorkerDeps {
  retrieve(sessionId: string): AgentSession | undefined;
  ensure(session: AgentSession): Promise<void>;
  stop(environmentId: string): Promise<void>;
}

/**
 * Webhook worker. Retrieve the session, ignore deleted sessions and resolved
 * actions, start the executor only for environment_connection, and release
 * compute for a session that is still failed. Deleting a session does not
 * come through here.
 */
export async function handleEnvironmentEvent(event: ApiEvent, deps: EnvironmentWorkerDeps): Promise<QueueDecision> {
  const decision = queueDecision(event);
  if (decision === 'ignore') return 'ignore';
  const sessionId = String(event.data.id || '');
  const session = deps.retrieve(sessionId);
  if (!session || session.deleted) return 'ignore';
  if (decision === 'release') {
    if (session.status === 'failed') await deps.stop(session.environment.id);
    return 'release';
  }
  const stillNeeds = session.required_actions.some((action) => action.type === 'environment_connection');
  if (!stillNeeds) return 'ignore';
  await deps.ensure(session);
  return 'provision';
}
