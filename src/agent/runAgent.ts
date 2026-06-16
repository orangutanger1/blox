import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';
import type { ImageInput } from './imageInput.js';
import type { EventSink } from '../panel/events.js';
import { eventsFromMessage } from '../panel/translate.js';
import { noticeFromStderr } from './notices.js';

// How often to remind the dock the run is alive while waiting on the model's
// first message. Covers the case where the SDK retries silently (e.g. a 429 the
// CLI didn't print to stderr) — without this the dock looks dead for minutes.
const HEARTBEAT_MS = 15_000;

// The SDK accepts either a string prompt or a stream of user messages. With an
// image we send one user message carrying [text, image] content blocks; without
// one we keep the plain string path (zero change for normal runs).
export function buildPromptInput(
  prompt: string,
  image?: ImageInput,
): string | AsyncIterable<SDKUserMessage> {
  if (!image) return prompt;
  const message = {
    type: 'user' as const,
    parent_tool_use_id: null,
    message: {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: prompt },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.base64 },
        },
      ],
    },
  };
  return (async function* () {
    yield message as SDKUserMessage;
  })();
}

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
  image?: ImageInput;
  // Aborting this controller's signal cancels the in-flight query (the dock's
  // Cancel button). Plumbed straight into the SDK's Options.abortController.
  abortController?: AbortController;
  // Env for the model call (SDK Options.env). The daemon sets ANTHROPIC_BASE_URL
  // to CCR here so a `provider,slug` model routes per-request instead of 404ing
  // at api.anthropic.com.
  env?: Record<string, string>;
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
  const sink = extras.sink;
  const input = buildPromptInput(prompt, extras.image);

  // Forward only rate-limit/retry lines from the CLI's stderr to the dock, so a
  // 429 surfaces instead of a silent stall. Stderr arrives in arbitrary chunks;
  // buffer and split on newlines. Throttle repeats so a retry storm doesn't spam.
  let stderrTail = '';
  let lastNotice = '';
  const stderr = sink
    ? (data: string) => {
        stderrTail += data;
        const lines = stderrTail.split('\n');
        stderrTail = lines.pop() ?? '';
        for (const line of lines) {
          const notice = noticeFromStderr(line);
          if (notice && notice !== lastNotice) {
            lastNotice = notice;
            try {
              sink.emit({ type: 'log', text: notice });
            } catch {
              /* degraded panel beats a dead run */
            }
          }
        }
      }
    : undefined;

  // Heartbeat until the first message arrives, so even a silent retry never
  // leaves the dock looking dead. Cleared on the first message and in finally.
  let firstSeen = false;
  const heartbeat =
    sink &&
    setInterval(() => {
      if (firstSeen) return;
      try {
        sink.emit({ type: 'log', text: '…still waiting for the model (slow or rate-limited)' });
      } catch {
        /* swallow */
      }
    }, HEARTBEAT_MS);

  const queryOptions = {
    ...options,
    ...(extras.abortController ? { abortController: extras.abortController } : {}),
    ...(extras.env ? { env: extras.env } : {}),
    ...(stderr ? { stderr } : {}),
  };
  try {
    for await (const message of query({ prompt: input, options: queryOptions as never })) {
      if (!firstSeen) {
        firstSeen = true;
        if (heartbeat) clearInterval(heartbeat);
      }
      if (sink) {
        // The panel is observability, never control flow: a throwing sink must
        // not take down the run (spec §7).
        try {
          for (const e of eventsFromMessage(message)) sink.emit(e);
          if (message.type === 'assistant') {
            turns += 1;
            sink.emit({ type: 'status', turns });
          }
        } catch {
          // swallow — degraded panel beats a dead run
        }
      }
      if (message.type === 'result') {
        result = summarizeResult(
          message as unknown as ResultMessageLike,
          extras.dockDeniedTools?.() ?? [],
        );
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  return result;
}
