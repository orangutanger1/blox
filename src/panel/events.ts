// Wire protocol between the CLI's panel server and the Studio dock plugin.
// Bump PROTOCOL_VERSION on any breaking change; the plugin shows an update
// hint on mismatch and the CLI runs unaffected (spec §4).
export const PROTOCOL_VERSION = 4;

export type GateDecisionValue = 'allow' | 'deny';
export type ResultDecisionValue = 'approve' | 'reject';
export type GateSource = 'dock' | 'timeout';

export type PanelEvent =
  | { type: 'run_started'; runId: string; prompt: string; mode: 'auto' | 'ask'; maxTurns: number; maxBudgetUsd: number; model: string }
  | { type: 'status'; turns: number }
  | { type: 'log'; text: string }
  | { type: 'file_diff'; path: string; added: number; removed: number }
  | { type: 'gate_request'; gateId: string; tool: string; inputSummary: string }
  | { type: 'gate_resolved'; gateId: string; decision: GateDecisionValue; source: GateSource }
  | { type: 'result_gate_request'; gateId: string; tool: string; tag: string | null; inputSummary: string }
  | { type: 'result_gate_resolved'; gateId: string; decision: ResultDecisionValue; source: GateSource; feedback?: string }
  | { type: 'image_request' }
  | { type: 'run_finished'; status: 'success' | 'error'; stopReason: string; turns: number; costUsd: number };

export interface EventSink {
  emit(event: PanelEvent): void;
}
