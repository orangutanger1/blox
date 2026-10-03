// Minimal `codex app-server` stand-in for runner tests. Scenario via argv[2]:
// tool (default): one read_file call, then a reply | builtin: starts a shell
// item | signedout: no account | loop: calls list_files until stopped.
import readline from 'node:readline';
const scenario = process.argv[2] ?? 'tool';
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const T = 'thr_1', U = 'turn_1';
let sid = 1000;
const waiting = new Map();
const seen = [];
const callTool = (tool, args) => new Promise((r) => { const id = ++sid; waiting.set(id, r); out({ id, method: 'item/tool/call', params: { threadId: T, turnId: U, callId: 'c' + id, namespace: null, tool, arguments: args } }); });
const complete = (status, error = null) => out({ method: 'turn/completed', params: { threadId: T, turn: { id: U, status, error, items: [] } } });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.method) seen.push(m.method);
  if (m.id !== undefined && !m.method) return waiting.get(m.id)?.(m.result ?? m.error);
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'fake' });
    case 'account/read': return reply({ account: scenario === 'signedout' ? null : { type: 'chatgpt', email: 'a@b.c', planType: 'plus' } });
    case 'thread/start':
      process.stderr.write(JSON.stringify({ tools: m.params.dynamicTools.map((t) => t.name), sandbox: m.params.sandbox, approval: m.params.approvalPolicy }) + '\n');
      return reply({ thread: { id: T } });
    case 'turn/interrupt': reply({}); return complete('interrupted');
    case 'turn/start': {
      reply({ turn: { id: U, status: 'inProgress' } });
      if (scenario === 'builtin') return out({ method: 'item/started', params: { threadId: T, turnId: U, item: { type: 'commandExecution', id: 'x' } } });
      if (scenario === 'loop') { for (;;) { const r = await callTool('list_files', {}); if (!r?.success) return; } }
      const r = scenario === 'slow' ? await callTool('run_luau', { code: 'return 1' }) : await callTool('read_file', { path: 'hello.txt' });
      out({ method: 'thread/tokenUsage/updated', params: { threadId: T, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, cacheWriteInputTokens: 0, totalTokens: 107, reasoningOutputTokens: 0 }, last: {} } } });
      out({ method: 'item/completed', params: { threadId: T, item: { type: 'agentMessage', text: 'file says: ' + r.contentItems[0].text } } });
      return complete('completed');
    }
  }
});
