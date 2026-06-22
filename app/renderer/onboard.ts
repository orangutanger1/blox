// app/renderer/onboard.ts
type Step = { status: 'ok' | 'missing' | 'error'; detail: string };
declare global {
  interface Window {
    bloxSetup: {
      authSave(k: string): Promise<boolean>;
      authStatus(): Promise<boolean>;
      detectRojo(): Promise<Step>;
      installRojo(): Promise<Step>;
      installPlugin(): Promise<Step>;
      checkStudio(): Promise<Step>;
      onboardState(): Promise<boolean>;
      onboardComplete(): Promise<boolean>;
    };
  }
}

const root = document.getElementById('app')!;
function line(label: string, r: Step) { return `<div>${r.status === 'ok' ? '✓' : '✗'} ${label}: ${r.detail}</div>`; }

export async function runOnboarding(onDone: () => void): Promise<void> {
  if (await window.bloxSetup.onboardState()) return onDone();
  root.innerHTML = `
    <h2>Set up blox</h2>
    <div>1. Paste your Anthropic API key (get one at console.anthropic.com):</div>
    <input id="key" style="width:70%" /> <button id="saveKey">Save</button>
    <div><button id="rojo">2. Set up Rojo</button> <span id="rojoOut"></span></div>
    <div><button id="plugin">3. Install Studio plugin</button> <span id="pluginOut"></span></div>
    <div><button id="studio">4. Check Studio connection</button> <span id="studioOut"></span></div>
    <div><button id="finish" disabled>Finish</button></div>
  `;
  const $ = (id: string) => document.getElementById(id)!;
  let keyOk = false, rojoOk = false, pluginOk = false, studioOk = false;
  const refresh = () => { ($('finish') as HTMLButtonElement).disabled = !(keyOk && rojoOk && pluginOk && studioOk); };

  $('saveKey').addEventListener('click', async () => {
    const k = ($('key') as HTMLInputElement).value.trim();
    if (k) { await window.bloxSetup.authSave(k); keyOk = true; ($('saveKey') as HTMLButtonElement).textContent = 'Saved ✓'; refresh(); }
  });
  $('rojo').addEventListener('click', async () => {
    let r = await window.bloxSetup.detectRojo();
    if (r.status !== 'ok') r = await window.bloxSetup.installRojo();
    $('rojoOut').innerHTML = line('rojo', r); rojoOk = r.status === 'ok'; refresh();
  });
  $('plugin').addEventListener('click', async () => {
    const r = await window.bloxSetup.installPlugin();
    $('pluginOut').innerHTML = line('plugin', r); pluginOk = r.status === 'ok'; refresh();
  });
  $('studio').addEventListener('click', async () => {
    const r = await window.bloxSetup.checkStudio();
    $('studioOut').innerHTML = line('studio', r); studioOk = r.status === 'ok'; refresh();
  });
  $('finish').addEventListener('click', async () => { await window.bloxSetup.onboardComplete(); onDone(); });
}
