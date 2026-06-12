import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';
import type { EventSink } from '../panel/events.js';
import { eventsFromMessage } from '../panel/translate.js';

export type StopReason = 'completed' | 'maxTurns' | 'budget' | 'gated' | 'error';

// Map an SDK result-message subtype to a coarse stop reason for the report.
export function classifyStop(subtype: string): StopReason {
  switch (subtype) {
    case 'success':
      return 'completed';
    case 'error_max_turns':
      return 'maxTurns';
    case 'error_max_budget_usd':
      return 'budget';
    default:
      return 'error';
  }
}

export interface GatedAction {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentRunResult {
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason: StopReason;
  detail: string;
  sessionId: string | null;
  gatedActions: GatedAction[];
  deniedByUser: string[];
}

interface ResultMessageLike {
  subtype: string;
  num_turns: number;
  total_cost_usd: number;
  session_id: string;
  permission_denials?: { tool_name: string; tool_input: Record<string, unknown> }[];
}

// Build the run result from an SDK 'result' message. Denials split two ways:
// dock-denied tools were resolved BY the user (listed informationally, run not
// failed for them); the rest are unresolved gates which override the stop
// reason and force a non-zero status, exactly as before the panel existed.
export function summarizeResult(
  message: ResultMessageLike,
  dockDeniedTools: string[] = [],
): AgentRunResult {
  const remainingDenied = [...dockDeniedTools];
  const gatedActions: GatedAction[] = [];
  const deniedByUser: string[] = [];
  for (const d of message.permission_denials ?? []) {
    const i = remainingDenied.indexOf(d.tool_name);
    if (i >= 0) {
      remainingDenied.splice(i, 1);
      deniedByUser.push(d.tool_name);
    } else {
      gatedActions.push({ tool: d.tool_name, input: d.tool_input });
    }
  }
  const gated = gatedActions.length > 0;
  const baseStatus: 'success' | 'error' = message.subtype === 'success' ? 'success' : 'error';
  return {
    numTurns: message.num_turns,
    costUsd: message.total_cost_usd,
    status: gated ? 'error' : baseStatus,
    stopReason: gated ? 'gated' : classifyStop(message.subtype),
    detail: gated ? 'gated' : message.subtype,
    sessionId: message.session_id,
    gatedActions,
    deniedByUser,
  };
}

export interface RunAgentExtras {
  sink?: EventSink;
  dockDeniedTools?: () => string[];
}

export async function runAgent(
  prompt: string,
  options: QueryOptionsLike,
  extras: RunAgentExtras = {},
): Promise<AgentRunResult> {
  let result: AgentRunResult = {
    numTurns: 0,
    costUsd: 0,
    status: 'error',
    stopReason: 'error',
    detail: 'no result',
    sessionId: null,
    gatedActions: [],
    deniedByUser: [],
  };
  let turns = 0;
  for await (const message of query({ prompt, options: options as never })) {
    if (extras.sink) {
      for (const e of eventsFromMessage(message)) extras.sink.emit(e);
      if (message.type === 'assistant') {
        turns += 1;
        extras.sink.emit({ type: 'status', turns });
      }
    }
    if (message.type === 'result') {
      result = summarizeResult(
        message as unknown as ResultMessageLike,
        extras.dockDeniedTools?.() ?? [],
      );
    }
  }
  return result;
}
