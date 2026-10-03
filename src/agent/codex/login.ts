import { CodexAppServer, bloxCodexHome } from './appServer.js';

// `blox auth codex [--device] | status | logout`: the ChatGPT sign-in for
// --runner codex, held by Codex in blox's own CODEX_HOME (never the user's
// ~/.codex, never read by blox).

export async function codexAuthCommand(sub: string | undefined, say: (s: string) => void, server = new CodexAppServer()): Promise<number> {
  try {
    if (sub === 'status') {
      const a = await server.account();
      say(a ? `codex: signed in to ChatGPT${a.planType ? ` (${a.planType})` : ''}${a.email ? ` as ${a.email}` : ''} — ${bloxCodexHome()}` : 'codex: not signed in (run `blox auth codex`)');
      return a ? 0 : 1;
    }
    if (sub === 'logout') {
      await server.request('account/logout', {});
      say('codex: signed out');
      return 0;
    }
    const existing = await server.account();
    if (existing) {
      say(`codex: already signed in${existing.email ? ` as ${existing.email}` : ''}`);
      return 0;
    }
    const device = sub === '--device';
    const r = await server.request<Record<string, string>>('account/login/start', device ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt', useHostedLoginSuccessPage: true });
    const loginId = r.loginId;
    if (device) say(`open ${r.verificationUrl} and enter the code ${r.userCode}`);
    else say(`open this URL to sign in with ChatGPT (from WSL, if the final redirect fails retry with \`blox auth codex --device\`):\n${r.authUrl}`);
    const ok = await new Promise<boolean>((resolve) => {
      const stop = server.subscribe((n) => {
        if (n.method !== 'account/login/completed' || (n.params.loginId && n.params.loginId !== loginId)) return;
        if (n.params.success !== true && n.params.error) say(`sign-in failed: ${String(n.params.error)}`);
        finish(n.params.success === true);
      });
      const poll = setInterval(() => void server.account().then((a) => a && finish(true), () => undefined), 3000);
      const timeout = setTimeout(() => finish(false), 10 * 60_000);
      const finish = (v: boolean) => {
        stop();
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(v);
      };
    });
    if (!ok) {
      await server.request('account/login/cancel', { loginId }).catch(() => undefined);
      say('codex: sign-in did not finish');
      return 1;
    }
    const a = await server.account();
    say(`codex: signed in${a?.email ? ` as ${a.email}` : ''}; use it with \`blox --runner codex "<task>"\``);
    return 0;
  } catch (e) {
    say((e as Error).message);
    return 1;
  } finally {
    server.close();
  }
}
