import { describe, it, expect, vi } from 'vitest';
import { GateBroker } from '../src/panel/gates.js';
import type { PanelEvent } from '../src/panel/events.js';

function collector() {
  const events: PanelEvent[] = [];
  return { sink: { emit: (e: PanelEvent) => events.push(e) }, events };
}

describe('GateBroker', () => {
  it('emits gate_request and resolves allow from the dock', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.request('mcp__Roblox_Studio__generate_mesh', { prompt: 'rock' });
    const req = events.find((e) => e.type === 'gate_request');
    expect(req).toBeDefined();
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    expect(req.tool).toBe('mcp__Roblox_Studio__generate_mesh');
    expect(req.inputSummary).toContain('rock');
    expect(broker.resolve(req.gateId, 'allow')).toBe(true);
    expect(await p).toEqual({ decision: 'allow', source: 'dock' });
    expect(events.some((e) => e.type === 'gate_resolved' && e.decision === 'allow' && e.source === 'dock')).toBe(true);
  });

  it('records dock-denied tools for the report split', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.request('mcp__Roblox_Studio__start_stop_play', {});
    const req = events.find((e) => e.type === 'gate_request');
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    broker.resolve(req.gateId, 'deny');
    expect(await p).toEqual({ decision: 'deny', source: 'dock' });
    expect(broker.dockDeniedTools()).toEqual(['mcp__Roblox_Studio__start_stop_play']);
  });

  it('times out to deny with source timeout', async () => {
    vi.useFakeTimers();
    try {
      const { sink, events } = collector();
      const broker = new GateBroker(sink, 1000);
      const p = broker.request('mcp__Roblox_Studio__generate_mesh', {});
      vi.advanceTimersByTime(1001);
      expect(await p).toEqual({ decision: 'deny', source: 'timeout' });
      expect(events.some((e) => e.type === 'gate_resolved' && e.source === 'timeout')).toBe(true);
      expect(broker.dockDeniedTools()).toEqual([]); // timeout is not a user decision
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false for unknown or already-resolved gate ids', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    expect(broker.resolve('nope', 'allow')).toBe(false);
    const p = broker.request('mcp__Roblox_Studio__generate_mesh', {});
    const req = events.find((e) => e.type === 'gate_request');
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    broker.resolve(req.gateId, 'allow');
    await p;
    expect(broker.resolve(req.gateId, 'deny')).toBe(false);
  });

  it('truncates huge input summaries', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.request('mcp__Roblox_Studio__generate_mesh', { prompt: 'x'.repeat(1000) });
    const req = events.find((e) => e.type === 'gate_request');
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    expect(req.inputSummary.length).toBeLessThanOrEqual(200);
    broker.resolve(req.gateId, 'allow');
    await p;
  });
});

describe('GateBroker — result gates', () => {
  it('emits result_gate_request and resolves approve with feedback ignored', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.requestResult('mcp__Roblox_Studio__generate_mesh', 'Assistant-MeshGen-abc', '{"textPrompt":"barrel"}');
    const req = events.find((e) => e.type === 'result_gate_request');
    if (req?.type !== 'result_gate_request') throw new Error('unreachable');
    expect(req.tool).toBe('mcp__Roblox_Studio__generate_mesh');
    expect(req.tag).toBe('Assistant-MeshGen-abc');
    expect(broker.resolve(req.gateId, 'approve')).toBe(true);
    expect(await p).toEqual({ decision: 'approve', source: 'dock' });
    expect(events.some((e) => e.type === 'result_gate_resolved' && e.decision === 'approve')).toBe(true);
  });

  it('resolves reject with feedback and records the decision', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.requestResult('mcp__Roblox_Studio__generate_mesh', 'Assistant-MeshGen-abc', '{}');
    const req = events.find((e) => e.type === 'result_gate_request');
    if (req?.type !== 'result_gate_request') throw new Error('unreachable');
    broker.resolve(req.gateId, 'reject', 'too tall, more barrel-shaped');
    expect(await p).toEqual({ decision: 'reject', source: 'dock', feedback: 'too tall, more barrel-shaped' });
    expect(broker.resultDecisions()).toEqual([
      { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'reject', source: 'dock', feedback: 'too tall, more barrel-shaped' },
    ]);
  });

  it('times out to APPROVE with source timeout (asymmetric vs tool gates)', async () => {
    vi.useFakeTimers();
    try {
      const { sink, events } = collector();
      const broker = new GateBroker(sink, 1000);
      const p = broker.requestResult('mcp__Roblox_Studio__generate_mesh', null, '{}');
      vi.advanceTimersByTime(1001);
      expect(await p).toEqual({ decision: 'approve', source: 'timeout' });
      expect(events.some((e) => e.type === 'result_gate_resolved' && e.source === 'timeout')).toBe(true);
      expect(broker.resultDecisions()).toEqual([
        { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'approve', source: 'timeout' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects decisions that do not match the gate kind', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const tp = broker.request('mcp__Roblox_Studio__generate_mesh', {});
    const rp = broker.requestResult('mcp__Roblox_Studio__generate_mesh', null, '{}');
    const treq = events.find((e) => e.type === 'gate_request');
    const rreq = events.find((e) => e.type === 'result_gate_request');
    if (treq?.type !== 'gate_request' || rreq?.type !== 'result_gate_request') throw new Error('unreachable');
    expect(broker.resolve(treq.gateId, 'approve')).toBe(false); // tool gate: allow|deny only
    expect(broker.resolve(rreq.gateId, 'allow')).toBe(false); // result gate: approve|reject only
    expect(broker.kindOf(treq.gateId)).toBe('tool');
    expect(broker.kindOf(rreq.gateId)).toBe('result');
    expect(broker.kindOf('nope')).toBeUndefined();
    broker.resolve(treq.gateId, 'allow');
    broker.resolve(rreq.gateId, 'approve');
    await Promise.all([tp, rp]);
    expect(broker.kindOf(treq.gateId)).toBeUndefined(); // resolved gates forgotten
  });
});
