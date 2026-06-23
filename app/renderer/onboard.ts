// app/renderer/onboard.ts
type Step = { status: 'ok' | 'missing' | 'error'; detail: string };
declare global {
  interface Window {
    bloxSetup: {
      authSave(k: string): Promise<boolean>;
      authStatus(): Promise<boolean>;
      authLoginSubscription(): Promise<{ linked: boolean; detail?: string; error?: string }>;
      authSubscriptionStatus(): Promise<{ linked: boolean; detail?: string; error?: string }>;
      addModel(kind: 'openrouter' | 'local', opts: { key?: string; baseUrl?: string; models: string[] }): Promise<{ ok: boolean; detail: string }>;
      listModels(): Promise<string[]>;
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
    <div>1. Connect Anthropic — either option works:</div>
    <div><button id="signin">Sign in with Anthropic (subscription)</button> <span id="signinOut"></span></div>
    <div>or paste an API key (console.anthropic.com): <input id="key" style="width:50%" /> <button id="saveKey">Save</button></div>
    <div>or use another model (optional):
      <select id="provider"><option value="openrouter">OpenRouter</option><option value="local">Local (Ollama)</option></select>
      <input id="provKey" placeholder="OpenRouter key" style="width:28%" />
      <input id="provModel" placeholder="model slug e.g. deepseek/deepseek-chat" style="width:28%" />
      <button id="addModel">Add</button> <span id="modelOut"></span></div>
    <div><button id="rojo">2. Set up Rojo</button> <span id="rojoOut"></span></div>
    <div><button id="plugin">3. Install Studio plugin</button> <span id="pluginOut"></span></div>
    <div><button id="studio">4. Check Studio connection</button> <span id="studioOut"></span></div>
    <div><button id="finish" disabled>Finish</button></div>
  `;
  const $ = (id: string) => document.getElementById(id)!;
  let authOk = false, rojoOk = false, pluginOk = false, studioOk = false;
  const refresh = () => { ($('finish') as HTMLButtonElement).disabled = !(authOk && rojoOk && pluginOk && studioOk); };

  // Already signed in from a prior session? Reflect it.
  void window.bloxSetup.authSubscriptionStatus().then((s) => {
    if (s.linked) { authOk = true; $('signinOut').textContent = `signed in${s.detail ? ` (${s.detail})` : ''} ✓`; refresh(); }
  });

  $('signin').addEventListener('click', async () => {
    const btn = $('signin') as HTMLButtonElement;
    btn.disabled = true; $('signinOut').textContent = 'opening sign-in window…';
    const s = await window.bloxSetup.authLoginSubscription();
    if (s.linked) { authOk = true; $('signinOut').textContent = `signed in${s.detail ? ` (${s.detail})` : ''} ✓`; }
    else { $('signinOut').textContent = s.error ?? 'sign-in not completed'; btn.disabled = false; }
    refresh();
  });

  $('saveKey').addEventListener('click', async () => {
    const k = ($('key') as HTMLInputElement).value.trim();
    if (k) { await window.bloxSetup.authSave(k); authOk = true; ($('saveKey') as HTMLButtonElement).textContent = 'Saved ✓'; refresh(); }
  });

  $('addModel').addEventListener('click', async () => {
    const kind = ($('provider') as HTMLSelectElement).value as 'openrouter' | 'local';
    const model = ($('provModel') as HTMLInputElement).value.trim();
    const key = ($('provKey') as HTMLInputElement).value.trim();
    if (!model) { $('modelOut').textContent = 'enter a model slug'; return; }
    $('modelOut').textContent = 'adding (installing router if needed)…';
    const r = await window.bloxSetup.addModel(kind, { models: [model], key: key || undefined });
    $('modelOut').textContent = r.ok ? `added ${kind} ✓` : (r.detail || 'failed');
    // A configured routed provider is valid credentials too — satisfy the auth gate.
    if (r.ok) { authOk = true; refresh(); }
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
