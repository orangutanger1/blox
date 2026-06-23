export function renderCommitMessage(
  template: string | undefined,
  ctx: { prompt: string; user: string; model: string; date: string },
): string {
  const t = template ?? 'blox: {prompt}';
  return t.replace(/\{(prompt|user|model|date)\}/g, (_m, key: keyof typeof ctx) => ctx[key]);
}
