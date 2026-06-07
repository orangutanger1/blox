import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';

export interface AgentRunResult {
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  detail: string;
}

export async function runAgent(
  prompt: string,
  options: QueryOptionsLike,
): Promise<AgentRunResult> {
  let result: AgentRunResult = { numTurns: 0, costUsd: 0, status: 'error', detail: 'no result' };
  for await (const message of query({ prompt, options: options as never })) {
    if (message.type === 'result') {
      result = {
        numTurns: message.num_turns,
        costUsd: message.total_cost_usd,
        status: message.subtype === 'success' ? 'success' : 'error',
        detail: message.subtype,
      };
    }
  }
  return result;
}
