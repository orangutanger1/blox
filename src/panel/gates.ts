import { randomUUID } from 'node:crypto';
import type { EventSink, GateDecisionValue, GateSource } from './events.js';

export interface GateDecision {
  decision: GateDecisionValue;
  source: GateSource;
}

// Pending-gate registry. request() publishes a gate_request event and parks the
// agent's canUseTool callback on a promise; the dock resolves it via the
// server's POST /gate/{id}, or the timeout falls back to deny (spec §5, §7).
export class GateBroker {
  private pending = new Map<string, (d: GateDecision) => void>();
  private denied: string[] = []; // tools the USER denied (timeouts excluded)

  constructor(
    private sink: EventSink,
    private timeoutMs: number,
  ) {}

  request(tool: string, input: Record<string, unknown>): Promise<GateDecision> {
    const gateId = randomUUID();
    this.sink.emit({
      type: 'gate_request',
      gateId,
      tool,
      inputSummary: JSON.stringify(input).slice(0, 200),
    });
    return new Promise((resolve) => {
      const finish = (d: GateDecision) => {
        if (!this.pending.has(gateId)) return; // idempotent: first resolution wins
        this.pending.delete(gateId);
        clearTimeout(timer);
        if (d.decision === 'deny' && d.source === 'dock') this.denied.push(tool);
        try {
          this.sink.emit({ type: 'gate_resolved', gateId, decision: d.decision, source: d.source });
        } finally {
          resolve(d); // a throwing sink must never leave the agent parked
        }
      };
      const timer = setTimeout(() => finish({ decision: 'deny', source: 'timeout' }), this.timeoutMs);
      this.pending.set(gateId, finish);
    });
  }

  resolve(gateId: string, decision: GateDecisionValue): boolean {
    const finish = this.pending.get(gateId);
    if (!finish) return false;
    finish({ decision, source: 'dock' });
    return true;
  }

  // Tools denied interactively — the report lists these as user decisions, not
  // as "blocked, re-run with --auto" (spec §5).
  dockDeniedTools(): string[] {
    return [...this.denied];
  }
}
