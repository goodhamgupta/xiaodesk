export type EnvironmentStatus = 'pending' | 'connected' | 'disconnected' | 'failed';
export type SessionStatus = 'idle' | 'in_progress' | 'failed';
export type RequiredActionType = 'environment_connection' | 'function_call' | 'computer_use_approval_request';

export interface RequiredAction {
  id: string;
  type: RequiredActionType;
}

export interface AgentEnvironment {
  id: string;
  object: 'agent.environment';
  type: 'self_hosted';
  status: EnvironmentStatus;
  remote_url: string;
  workspace_directory: string;
}

export interface AgentSession {
  id: string;
  object: 'agent.session';
  status: SessionStatus;
  created_at: number;
  deleted: boolean;
  agent: { model: string; instructions?: string };
  environment: AgentEnvironment;
  required_actions: RequiredAction[];
  metadata: Record<string, unknown>;
  pending_input: unknown;
  error?: { message: string };
}

export interface ApiEvent {
  id: string;
  object: 'event';
  created_at: number;
  type: string;
  data: Record<string, unknown>;
}

export type QueueDecision = 'provision' | 'release' | 'ignore';

export function queueDecision(event: { type: string; data?: { required_action?: { type?: string } } }): QueueDecision {
  if (event.type === 'agent.session.failed') return 'release';
  if (event.type === 'agent.session.action_required' && event.data?.required_action?.type === 'environment_connection') {
    return 'provision';
  }
  return 'ignore';
}

export const LAB_APP_KEY = 'lab-app';
export const LAB_EXECUTOR_KEY = 'lab-executor';
export const LAB_WEBHOOK_SECRET = `whsec_${Buffer.from('microvm-workshop-webhook-secret!!').toString('base64')}`;
