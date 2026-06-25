import { describe, it, expect } from 'vitest';
import { usageFromJson, usageFromSse } from '../src/relay/usage.js';

describe('usageFromJson', () => {
  it('reads usage fields, defaulting missing ones to 0', () => {
    expect(usageFromJson({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }))
      .toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 });
  });
  it('returns zeros for a body with no usage', () => {
    expect(usageFromJson({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('usageFromSse', () => {
  it('takes input+cache from message_start and output from the final message_delta', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":10,"cache_creation_input_tokens":3,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
      '',
    ].join('\n');
    expect(usageFromSse(sse)).toEqual({ input: 200, output: 42, cacheRead: 10, cacheWrite: 3 });
  });
});
