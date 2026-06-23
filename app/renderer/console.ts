// app/renderer/console.ts
import { createPanelClient } from '../shared/panelClient.js';

declare global {
  interface Window {
    blox: {
      panelBase(): Promise<string>;
      runStart(p: unknown): Promise<boolean>;
      runCancel(): Promise<boolean>;
      onRunExited(cb: (r: { code: number | null }) => void): void;
      onRunLog(cb: (text: string) => void): void;
      listModels(): Promise<string[]>;
    };
  }
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <input id="project" placeholder="project folder path" style="width:60%" />
  <div><textarea id="prompt" placeholder="describe what to build" rows="3" style="width:80%"></textarea></div>
  <select id="model"><option value="">Claude (default)</option></select>
  <button id="run">Run</button> <button id="cancel">Cancel</button>
  <pre id="log" style="height:360px;overflow:auto;background:#111;color:#ddd;padding:8px"></pre>
`;
void window.blox.listModels().then((models) => {
  const sel = document.getElementById('model') as HTMLSelectElement;
  sel.innerHTML = '<option value="">Claude (default)</option>'
    + models.map((m) => `<option value="${m}">${m}</option>`).join('');
});
const log = document.getElementById('log')!;
const append = (s: string) => { log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; };

let cursor = 0;
let runId: string | null = null;
let polling = false;

async function pollLoop(base: string): Promise<void> {
  if (polling) return;
  polling = true;
  const client = createPanelClient(base);
  // Reset the cursor on a new runId — same rule as the Studio plugin.
  for (;;) {
    const info = await client.info();
    if (info && info.runId !== runId) { runId = info.runId; cursor = 0; }
    const data = await client.poll(cursor);
    if (data) {
      cursor = data.cursor;
      for (const e of data.events as { type: string; text?: string; path?: string }[]) {
        if (e.type === 'log') append(e.text ?? '');
        else if (e.type === 'file_diff') append(`Δ ${e.path}`);
        else append(`· ${e.type}`);
      }
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

document.getElementById('run')!.addEventListener('click', async () => {
  const projectPath = (document.getElementById('project') as HTMLInputElement)
    .value.trim().replace(/^["']|["']$/g, '');
  const prompt = (document.getElementById('prompt') as HTMLTextAreaElement).value.trim();
  if (!projectPath || !prompt) { append('need a project path and a prompt'); return; }
  append('▶ starting run…');
  const model = (document.getElementById('model') as HTMLSelectElement).value || undefined;
  await window.blox.runStart({ prompt, projectPath, mode: 'ask', model });
  void pollLoop(await window.blox.panelBase());
});
document.getElementById('cancel')!.addEventListener('click', () => window.blox.runCancel());
window.blox.onRunExited((r) => append(`run exited (${r.code})`));
window.blox.onRunLog((text) => { if (text) append(text); });
