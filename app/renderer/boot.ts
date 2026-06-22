// app/renderer/boot.ts
import { runOnboarding } from './onboard.js';
runOnboarding(() => { void import('./console.js'); });
