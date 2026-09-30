import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';

export interface AppServerConfig {
  mode: 'mock' | 'real';
  realServerUrl?: string;
}

export interface Thread {
  id: string;
  created_at: Date;
  instructions?: string;
  model?: string;
}

export interface Turn {
  id: string;
  thread_id: string;
  user_message: string;
  assistant_response?: string;
  tool_calls: ToolCall[];
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'done';
  timestamp: Date;
  data: unknown;
}

export class MockAppServer extends EventEmitter {
  private threads: Map<string, Thread> = new Map();
  private turns: Map<string, Turn> = new Map();
  private toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>> = new Map();

  registerTool(name: string, handler: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.toolHandlers.set(name, handler);
  }

  async threadStart(params: { thread_id?: string; model?: string; instructions?: string }): Promise<Thread> {
    const thread: Thread = {
      id: params.thread_id || uuid(),
      created_at: new Date(),
      instructions: params.instructions,
      model: params.model || 'mock-model',
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async *turnStart(params: { 
    thread_id: string; 
    user_message: string;
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    stubActions?: StubAction[];
  }): AsyncGenerator<AgentEvent> {
    const thread = this.threads.get(params.thread_id);
    if (!thread) {
      yield { type: 'error', timestamp: new Date(), data: { error: 'Thread not found' } };
      return;
    }

    const turn: Turn = {
      id: uuid(),
      thread_id: params.thread_id,
      user_message: params.user_message,
      tool_calls: [],
      status: 'running',
    };
    this.turns.set(turn.id, turn);

    yield { type: 'thinking', timestamp: new Date(), data: { content: 'Analyzing task...' } };

    if (params.stubActions && params.stubActions.length > 0) {
      for (const action of params.stubActions) {
        yield { type: 'thinking', timestamp: new Date(), data: { content: `Planning: ${action.description || action.tool}` } };

        const toolCall: ToolCall = {
          id: uuid(),
          name: action.tool,
          arguments: action.args,
        };
        turn.tool_calls.push(toolCall);

        yield { type: 'tool_call', timestamp: new Date(), data: { tool: action.tool, args: action.args } };

        const handler = this.toolHandlers.get(action.tool);
        if (handler) {
          try {
            const result = await handler(action.args);
            toolCall.result = result;
            yield { type: 'tool_result', timestamp: new Date(), data: { tool: action.tool, result } };
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            toolCall.result = { error: errorMsg };
            yield { type: 'tool_result', timestamp: new Date(), data: { tool: action.tool, error: errorMsg } };
          }
        }

        if (action.delay_ms) {
          await new Promise(resolve => setTimeout(resolve, action.delay_ms));
        }
      }
    }

    turn.status = 'completed';
    turn.assistant_response = 'Task completed successfully.';

    yield { type: 'message', timestamp: new Date(), data: { content: turn.assistant_response } };
    yield { type: 'done', timestamp: new Date(), data: { turn_id: turn.id } };
  }

  getThread(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  getTurn(turnId: string): Turn | undefined {
    return this.turns.get(turnId);
  }
}

export interface StubAction {
  tool: string;
  args: Record<string, unknown>;
  description?: string;
  delay_ms?: number;
}

export function createMockAppServer(): MockAppServer {
  return new MockAppServer();
}
