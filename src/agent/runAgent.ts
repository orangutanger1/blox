import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';

export type StopReason = 'completed' | 'maxTurns' | 'budget' | 'error';

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

export interface AgentRunResult {
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason: StopReason;
  detail: string;
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
  };
  for await (const message of query({ prompt, options: options as never })) {
    if (message.type === 'result') {
      const subtype = message.subtype as string;
      result = {
        numTurns: message.num_turns,
        costUsd: message.total_cost_usd,
        status: subtype === 'success' ? 'success' : 'error',
        stopReason: classifyStop(subtype),
        detail: subtype,
      };
    }
  }
  return result;
}
