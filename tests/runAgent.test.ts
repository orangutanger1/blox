import { describe, it, expect } from 'vitest';
import { classifyStop } from '../src/agent/runAgent.js';

describe('classifyStop', () => {
  it('maps SDK result subtypes to stop reasons', () => {
    expect(classifyStop('success')).toBe('completed');
    expect(classifyStop('error_max_turns')).toBe('maxTurns');
    expect(classifyStop('error_max_budget_usd')).toBe('budget');
    expect(classifyStop('error_during_execution')).toBe('error');
    expect(classifyStop('anything_else')).toBe('error');
  });
});
