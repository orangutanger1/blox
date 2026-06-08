export interface ServeCheckReport {
  reachable: boolean;
  url: string;
  projectName?: string;
  protocolVersion?: number;
  serverVersion?: string;
  detail: string;
}

export interface FetchLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchFn = (url: string) => Promise<FetchLike>;

// rojo serve's info endpoint. Default 3s timeout so a dead port fails fast.
const defaultFetch: FetchFn = (url) => fetch(url, { signal: AbortSignal.timeout(3000) });

export function rojoServeUrl(): string {
  return process.env.BLOX_ROJO_SERVE_URL ?? 'http://localhost:34872';
}

export async function checkRojoServe(url: string, fetchFn: FetchFn = defaultFetch): Promise<ServeCheckReport> {
  const api = `${url.replace(/\/$/, '')}/api/rojo`;
  try {
    const res = await fetchFn(api);
    if (!res.ok) {
      return { reachable: false, url, detail: `rojo serve returned HTTP ${res.status} at ${api}` };
    }
    const body = (await res.json()) as { projectName?: string; protocolVersion?: number; serverVersion?: string };
    return {
      reachable: true, url,
      projectName: body.projectName,
      protocolVersion: body.protocolVersion,
      serverVersion: body.serverVersion,
      detail: `rojo serve reachable: project '${body.projectName ?? '?'}' (protocol ${body.protocolVersion ?? '?'}, rojo ${body.serverVersion ?? '?'})`,
    };
  } catch (err) {
    return { reachable: false, url, detail: `no rojo serve at ${api}: ${(err as Error)?.message ?? String(err)}` };
  }
}

export function formatServeCheck(r: ServeCheckReport): string {
  if (r.reachable) {
    return [`  sync:    SERVE REACHABLE (${r.url})`, `  project: ${r.projectName ?? '?'}`, `  detail:  ${r.detail}`].join('\n');
  }
  return [`  sync:    NO SERVE (${r.url})`, `  detail:  ${r.detail}`].join('\n');
}
