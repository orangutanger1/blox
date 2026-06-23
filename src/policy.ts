import type { BloxConfig } from './config.js';
import { readWindowSpend } from './audit.js';

export class PolicyError extends Error {
  field: string;
  requested?: unknown;
  cap?: unknown;
  constructor(field: string, message: string, requested?: unknown, cap?: unknown) {
    super(message);
    this.name = 'PolicyError';
    this.field = field;
    this.requested = requested;
    this.cap = cap;
  }
}

export function enforcePolicy(config: BloxConfig, now: Date = new Date()): void {
  const p = config.policy;
  if (!p) return;

  if (p.models && !p.models.includes(config.model)) {
    throw new PolicyError('model', `model "${config.model}" is not in the team allowlist [${p.models.join(', ')}]`, config.model, p.models);
  }
  if (p.maxBudgetUsd != null && config.maxBudgetUsd > p.maxBudgetUsd) {
    throw new PolicyError('maxBudgetUsd', `maxBudgetUsd ${config.maxBudgetUsd} exceeds team ceiling ${p.maxBudgetUsd}`, config.maxBudgetUsd, p.maxBudgetUsd);
  }
  if (p.maxTurns != null && config.maxTurns > p.maxTurns) {
    throw new PolicyError('maxTurns', `maxTurns ${config.maxTurns} exceeds team ceiling ${p.maxTurns}`, config.maxTurns, p.maxTurns);
  }
  if (p.mode === 'ask' && config.mode === 'auto') {
    throw new PolicyError('mode', `team policy requires mode "ask"; cannot run in "auto"`, config.mode, p.mode);
  }
  if (p.rollingBudget) {
    const spent = readWindowSpend(config.projectPath, p.rollingBudget.windowDays, now);
    if (spent >= p.rollingBudget.maxUsd) {
      throw new PolicyError(
        'rollingBudget',
        `team rolling budget reached: $${spent.toFixed(2)} spent in the last ${p.rollingBudget.windowDays}d meets/exceeds the $${p.rollingBudget.maxUsd} cap`,
        spent,
        p.rollingBudget.maxUsd,
      );
    }
  }
}
