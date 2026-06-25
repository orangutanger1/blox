import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface MembersStore { salt: string; members: Record<string, string> }

function hash(salt: string, token: string): string {
  return createHash('sha256').update(salt).update(token).digest('hex');
}

export function loadMembers(path: string): MembersStore {
  if (!existsSync(path)) return { salt: randomBytes(16).toString('hex'), members: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as MembersStore;
    if (typeof s.salt === 'string' && s.members && typeof s.members === 'object') return s;
  } catch {
    // fall through to a fresh store on a corrupt file
  }
  return { salt: randomBytes(16).toString('hex'), members: {} };
}

function save(path: string, store: MembersStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function addMember(path: string, email: string): string {
  const store = loadMembers(path);
  const token = 'blx_' + randomBytes(24).toString('base64url');
  store.members[hash(store.salt, token)] = email;
  save(path, store);
  return token;
}

export function removeMember(path: string, email: string): boolean {
  const store = loadMembers(path);
  const key = Object.keys(store.members).find((k) => store.members[k] === email);
  if (!key) return false;
  delete store.members[key];
  save(path, store);
  return true;
}

export function listMembers(path: string): string[] {
  return [...new Set(Object.values(loadMembers(path).members))].sort();
}

export function authMember(store: MembersStore, presentedKey: string): string | null {
  if (!presentedKey) return null;
  const h = hash(store.salt, presentedKey);
  for (const [stored, email] of Object.entries(store.members)) {
    const a = Buffer.from(h);
    const b = Buffer.from(stored);
    if (a.length === b.length && timingSafeEqual(a, b)) return email;
  }
  return null;
}
