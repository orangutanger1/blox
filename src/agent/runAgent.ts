import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';

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
}

interface ResultMessageLike {
  subtype: string;
  num_turns: number;
  total_cost_usd: number;
  session_id: string;
  permission_denials?: { tool_name: string; tool_input: Record<string, unknown> }[];
}

// Build the run result from an SDK 'result' message. Gated denials (collected in
// permission_denials[] by the canUseTool deny path) override the stop reason and
// force a non-zero status: the task did not complete without approval.
export function summarizeResult(message: ResultMessageLike): AgentRunResult {
  const gatedActions = (message.permission_denials ?? []).map((d) => ({
    tool: d.tool_name,
    input: d.tool_input,
  }));
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
  };
}

export async function runAgent(
  prompt: string,
  options: QueryOptionsLike,
): Promise<AgentRunResult> {
  let result: AgentRunResult = {
    numTurns: 0,
    costUsd: 0,
    status: 'error',
    stopReason: 'error',
    detail: 'no result',
    sessionId: null,
    gatedActions: [],
  };
  for await (const message of query({ prompt, options: options as never })) {
    if (message.type === 'result') {
      result = summarizeResult(message as unknown as ResultMessageLike);
    }
  }
  return result;
}
