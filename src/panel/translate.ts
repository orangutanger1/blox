import type { PanelEvent } from './events.js';

const LOG_LIMIT = 500;

function countLines(s: unknown): number {
  return typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0;
}

interface BlockLike {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

// File-diff summaries are derived from the tool inputs, not a real diff: good
// enough for the dock's "what changed" list (spec defers hunk rendering, §9).
function fileDiff(name: string, input: Record<string, unknown>): PanelEvent | null {
  const path = input.file_path;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (name === 'Edit') {
    return { type: 'file_diff', path, added: countLines(input.new_string), removed: countLines(input.old_string) };
  }
  if (name === 'Write') {
    return { type: 'file_diff', path, added: countLines(input.content), removed: 0 };
  }
  return null;
}

// Pure translation of one SDK stream message into panel events. Unknown
// message shapes translate to nothing — the panel must never break a run.
export function eventsFromMessage(message: unknown): PanelEvent[] {
  const m = message as { type?: unknown; message?: { content?: unknown } } | null;
  if (!m || m.type !== 'assistant' || !Array.isArray(m.message?.content)) return [];
  const events: PanelEvent[] = [];
  for (const block of m.message.content as BlockLike[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'log', text: block.text.slice(0, LOG_LIMIT) });
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ type: 'log', text: `tool: ${block.name}` });
      const input = (block.input ?? {}) as Record<string, unknown>;
      const diff = fileDiff(block.name, input);
      if (diff) events.push(diff);
    }
  }
  return events;
}
