// app/renderer/boot.ts
import { runOnboarding } from './onboard.js';

// Surface startup failures in the window instead of a silent "loading…" — e.g.
// a missing preload bridge (window.bloxSetup undefined).
runOnboarding(() => { void import('./console.js'); }).catch((e: unknown) => {
  const el = document.getElementById('app');
  const msg = e instanceof Error ? e.message : String(e);
  if (el) el.textContent = `startup error: ${msg}`;
});
