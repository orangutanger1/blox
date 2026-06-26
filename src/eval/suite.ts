import type { EvalTask } from './harness.js';

// Default benchmark suite — small, representative Roblox build tasks. Each runs
// as an --auto run against the configured project + a connected Studio. Ceilings
// are loose starting points; tune them per model once you have a baseline (the
// point of the harness is to replace guessed routedMaxTurns with measured ones).
//
// ponytail: pass criteria are coarse (run succeeded within turn/cost ceilings).
// Asserting the BUILD is correct (the right instances exist, behave right) needs
// per-task execute_luau probes — add them as a `verify` Luau snippet per task
// when a model's pass-rate here stops discriminating quality.
export const defaultSuite: EvalTask[] = [
  {
    name: 'module-greeter',
    prompt: 'Create a ModuleScript in ReplicatedStorage named Greeter with a greet(name) function that returns "Hello, <name>!". Verify it with execute_luau.',
    maxTurns: 8,
    maxCostUsd: 0.5,
  },
  {
    name: 'server-counter',
    prompt: 'Add a server Script in ServerScriptService that keeps an in-memory integer counter and exposes an increment() that returns the new value. Verify it.',
    maxTurns: 10,
    maxCostUsd: 0.75,
  },
  {
    name: 'client-hud-label',
    prompt: 'Create a LocalScript under StarterGui that adds a ScreenGui with a TextLabel showing "Score: 0". Verify the instances exist.',
    maxTurns: 12,
    maxCostUsd: 1.0,
  },
];
