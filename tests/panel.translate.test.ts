import { describe, it, expect } from 'vitest';
import { eventsFromMessage } from '../src/panel/translate.js';

function assistant(content: unknown[]) {
  return { type: 'assistant', message: { content } };
}

describe('eventsFromMessage', () => {
  it('turns text blocks into log events, truncated to 500 chars', () => {
    const events = eventsFromMessage(assistant([{ type: 'text', text: 'hello' }]));
    expect(events).toEqual([{ type: 'log', text: 'hello' }]);
    const long = eventsFromMessage(assistant([{ type: 'text', text: 'x'.repeat(600) }]));
    expect(long[0]).toMatchObject({ type: 'log' });
    if (long[0].type === 'log') expect(long[0].text.length).toBe(500);
  });

  it('turns tool_use blocks into tool log lines', () => {
    const events = eventsFromMessage(
      assistant([{ type: 'tool_use', name: 'mcp__Roblox_Studio__execute_luau', input: { script: 'print(1)' } }]),
    );
    expect(events).toEqual([{ type: 'log', text: 'tool: mcp__Roblox_Studio__execute_luau' }]);
  });

  it('adds a file_diff event for Edit with line counts from old/new strings', () => {
    const events = eventsFromMessage(
      assistant([
        {
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'src/Greeter.luau', old_string: 'a\nb', new_string: 'a\nb\nc' },
        },
      ]),
    );
    expect(events).toContainEqual({ type: 'file_diff', path: 'src/Greeter.luau', added: 3, removed: 2 });
  });

  it('adds a file_diff event for Write with content lines added', () => {
    const events = eventsFromMessage(
      assistant([{ type: 'tool_use', name: 'Write', input: { file_path: 'src/New.luau', content: 'x\ny' } }]),
    );
    expect(events).toContainEqual({ type: 'file_diff', path: 'src/New.luau', added: 2, removed: 0 });
  });

  it('ignores non-assistant messages and malformed blocks', () => {
    expect(eventsFromMessage({ type: 'result', subtype: 'success' })).toEqual([]);
    expect(eventsFromMessage(assistant([{ type: 'tool_use', name: 'Edit', input: {} }]))).toEqual([
      { type: 'log', text: 'tool: Edit' },
    ]);
    expect(eventsFromMessage(null)).toEqual([]);
  });
});
