// app/shared/ipc.ts
// Single source of truth for IPC channel names + payload types shared by
// main, preload, and renderer.
export const IPC = {
  runStart: 'run:start',
  runCancel: 'run:cancel',
  runExited: 'run:exited',
  panelBase: 'panel:base',
  authSave: 'auth:save',
  authStatus: 'auth:status',
  authClear: 'auth:clear',
  authLoginSubscription: 'auth:loginSubscription',
  authSubscriptionStatus: 'auth:subscriptionStatus',
  runLog: 'run:log',
  setupDetectRojo: 'setup:detectRojo',
  setupInstallRojo: 'setup:installRojo',
  setupInstallPlugin: 'setup:installPlugin',
  setupCheckStudio: 'setup:checkStudio',
  onboardState: 'onboard:state',
  onboardComplete: 'onboard:complete',
  modelAdd: 'model:add',
  modelList: 'model:list',
} as const;

export interface RunStartPayload {
  prompt: string;
  projectPath: string;
  mode: 'auto' | 'ask';
  maxTurns?: number;
  budgetUsd?: number;
  effort?: 'high' | 'xhigh';
  model?: string;
}
export interface StepResult { status: 'ok' | 'missing' | 'error'; detail: string }
