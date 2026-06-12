import { randomUUID } from 'node:crypto';
import type { EventSink, GateDecisionValue, ResultDecisionValue, GateSource } from './events.js';

export interface GateDecision {
  decision: GateDecisionValue;
  source: GateSource;
}

export interface ResultDecision {
  decision: ResultDecisionValue;
  source: GateSource;
  feedback?: string;
}

export interface ResultRecord extends ResultDecision {
  tool: string;
}

export type GateKind = 'tool' | 'result';

const VALID: Record<GateKind, readonly string[]> = {
  tool: ['allow', 'deny'],
  result: ['approve', 'reject'],
};

interface Pending {
  kind: GateKind;
  finish: (decision: string, source: GateSource, feedback?: string) => void;
}

// Pending-gate registry. request()/requestResult() publish a *_gate_request
// event and park the caller on a promise; the dock resolves it via the
// server's POST /gate/{id}, or the timeout fires the kind's default.
// Tool gates time out to DENY (default-safe: don't run the tool); result
// gates time out to APPROVE (default-safe: don't mutate the DataModel
// unattended — the asset already exists). Spec §3.
export class GateBroker {
  private pending = new Map<string, Pending>();
  private denied: string[] = []; // tools the USER denied (timeouts excluded)
  private results: ResultRecord[] = [];

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
      this.park(gateId, 'tool', 'deny', (decision, source) => {
        if (decision === 'deny' && source === 'dock') this.denied.push(tool);
        try {
          this.sink.emit({ type: 'gate_resolved', gateId, decision: decision as GateDecisionValue, source });
        } finally {
          resolve({ decision: decision as GateDecisionValue, source });
        }
      });
    });
  }

  requestResult(tool: string, tag: string | null, inputSummary: string): Promise<ResultDecision> {
    const gateId = randomUUID();
    this.sink.emit({ type: 'result_gate_request', gateId, tool, tag, inputSummary });
    return new Promise((resolve) => {
      this.park(gateId, 'result', 'approve', (decision, source, feedback) => {
        const d: ResultDecision = {
          decision: decision as ResultDecisionValue,
          source,
          ...(feedback ? { feedback } : {}),
        };
        this.results.push({ tool, ...d });
        try {
          this.sink.emit({ type: 'result_gate_resolved', gateId, ...d });
        } finally {
          resolve(d); // a throwing sink must never leave the agent parked
        }
      });
    });
  }

  private park(
    gateId: string,
    kind: GateKind,
    timeoutDecision: string,
    onFinish: (decision: string, source: GateSource, feedback?: string) => void,
  ): void {
    const finish: Pending['finish'] = (decision, source, feedback) => {
      if (!this.pending.has(gateId)) return; // idempotent: first resolution wins
      this.pending.delete(gateId);
      clearTimeout(timer);
      onFinish(decision, source, feedback);
    };
    const timer = setTimeout(() => finish(timeoutDecision, 'timeout'), this.timeoutMs);
    this.pending.set(gateId, { kind, finish });
  }

  kindOf(gateId: string): GateKind | undefined {
    return this.pending.get(gateId)?.kind;
  }

  resolve(gateId: string, decision: string, feedback?: string): boolean {
    const p = this.pending.get(gateId);
    if (!p || !VALID[p.kind].includes(decision)) return false;
    p.finish(decision, 'dock', feedback);
    return true;
  }

  // Tools denied interactively — the report lists these as user decisions, not
  // as "blocked, re-run with --auto" (spec §5).
  dockDeniedTools(): string[] {
    return [...this.denied];
  }

  // Result-gate outcomes for the report's assets section (P2 spec §4).
  resultDecisions(): ResultRecord[] {
    return [...this.results];
  }
}
