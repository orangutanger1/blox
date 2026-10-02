import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './chatLoop.js';

// Saved `--runner openai` conversations, for --resume/--continue. Kept outside
// the project (a run commits the whole tree) under the user's state dir.

export interface ChatSession {
  id: string;
  projectPath: string;
  model: string;
  updatedAt: string;
  messages: ChatMessage[]; // without the system prompt (rebuilt fresh on resume)
}

export function chatSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'blox', 'chat-sessions');
}

export const newChatSessionId = (): string => `oa-${randomUUID()}`;

// Images are large and only meaningful to the turn that saw them.
function stripImages(m: ChatMessage): ChatMessage {
  if (!Array.isArray(m.content)) return m;
  return { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: '[image omitted from the saved session]' } : p)) };
}

export function saveChatSession(s: Omit<ChatSession, 'updatedAt'>, dir = chatSessionsDir()): void {
  mkdirSync(dir, { recursive: true });
  const body: ChatSession = {
    ...s,
    projectPath: resolve(s.projectPath),
    updatedAt: new Date().toISOString(),
    messages: s.messages.filter((m) => m.role !== 'system').map(stripImages),
  };
  writeFileSync(join(dir, `${s.id}.json`), JSON.stringify(body), { mode: 0o600 });
}

export function loadChatSession(id: string, dir = chatSessionsDir()): ChatSession {
  if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id "${id}"`);
  const f = join(dir, `${id}.json`);
  if (!existsSync(f)) throw new Error(`no saved --runner openai session "${id}"`);
  return JSON.parse(readFileSync(f, 'utf8')) as ChatSession;
}

// The most recently updated session for this project, for --continue.
export function latestChatSession(projectPath: string, dir = chatSessionsDir()): ChatSession {
  const want = resolve(projectPath);
  const found = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map(({ f }) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ChatSession)
    .find((s) => s.projectPath === want);
  if (!found) throw new Error('no saved --runner openai session for this project to continue');
  return found;
}
