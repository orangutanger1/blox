// app/shared/panelClient.ts
export interface PanelInfo { protocol: number; runId: string; project: string }
export interface EventEnvelope { events: unknown[]; cursor: number }

// Mirrors the engine's panel HTTP API (src/panel/server.ts). All methods
// resolve to null/false on any network error so the UI degrades gracefully —
// the engine is "observability, never control flow".
export function createPanelClient(base: string) {
  const url = (p: string) => `${base}/api/v1${p}`;
  async function getJson<T>(p: string): Promise<T | null> {
    try {
      const res = await fetch(url(p));
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  async function post(p: string, body: BodyInit | Uint8Array, contentType: string): Promise<boolean> {
    try {
      const res = await fetch(url(p), { method: 'POST', headers: { 'content-type': contentType }, body: body as BodyInit });
      return res.ok;
    } catch {
      return false;
    }
  }
  return {
    info: () => getJson<PanelInfo>('/info'),
    poll: (cursor: number) => getJson<EventEnvelope>(`/events?cursor=${cursor}`),
    resolveGate: (gateId: string, decision: 'allow' | 'deny' | 'approve' | 'reject', feedback?: string) =>
      post(`/gate/${gateId}`, JSON.stringify(feedback ? { decision, feedback } : { decision }), 'application/json'),
    uploadImage: (bytes: Uint8Array, contentType: 'image/png' | 'image/jpeg') =>
      post('/image', bytes, contentType),
  };
}
