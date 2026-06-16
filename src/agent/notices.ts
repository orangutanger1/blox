// The Agent SDK's underlying CLI prints transient API failures (rate limits,
// overloads, retries) to stderr and retries silently with backoff — to the dock
// that looks like a dead "waiting for first response". We forward just these
// lines so a 429 shows up instead of stalling. Everything else on stderr is
// debug noise and is dropped.
const NOTICE_RE = /\b(429|503|502|529)\b|rate.?limit|overloaded|too many requests|retry|retrying|api error/i;

// Returns a short dock log string for a stderr line worth surfacing, else null.
export function noticeFromStderr(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || !NOTICE_RE.test(trimmed)) return null;
  const capped = trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
  return `model: ${capped}`;
}
