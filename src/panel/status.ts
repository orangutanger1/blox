// Doctor check for the panel control daemon (`blox panel serve`): hit its /info
// endpoint — the same one the Studio dock polls — so `blox doctor` reports
// whether the dock has anything to talk to.

export interface PanelFetchLike {
  ok: boolean;
  json(): Promise<unknown>;
}
export type PanelFetchFn = (url: string) => Promise<PanelFetchLike>;

const defaultFetch: PanelFetchFn = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

export interface PanelStatus {
  running: boolean;
  port: number;
  project?: string;
  protocol?: number;
  runId?: string;
}

export async function checkPanel(port: number, fetchFn: PanelFetchFn = defaultFetch): Promise<PanelStatus> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/api/v1/info`);
    if (!res.ok) return { running: false, port };
    const body = (await res.json()) as { project?: string; protocol?: number; runId?: string };
    return { running: true, port, project: body.project, protocol: body.protocol, runId: body.runId };
  } catch {
    return { running: false, port };
  }
}

export function formatPanelStatus(s: PanelStatus): string {
  if (!s.running) {
    return [
      `  panel:   NOT RUNNING (:${s.port})`,
      '  detail:  start `blox panel serve` for the Studio dock (launch/cancel runs)',
    ].join('\n');
  }
  const run = s.runId ? String(s.runId).slice(0, 8) : '?';
  return [
    `  panel:   RUNNING (:${s.port})`,
    `  project: ${s.project ?? '?'}`,
    `  detail:  protocol ${s.protocol ?? '?'}, run ${run}`,
  ].join('\n');
}
