import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMembers, addMember, removeMember, listMembers, authMember } from '../src/relay/members.js';

const newPath = () => join(mkdtempSync(join(tmpdir(), 'blox-')), 'relay-members.json');

describe('members store', () => {
  it('absent file loads an empty store with a salt', () => {
    const s = loadMembers(newPath());
    expect(s.members).toEqual({});
    expect(typeof s.salt).toBe('string');
  });

  it('addMember returns a blx_ token and never persists it raw', () => {
    const p = newPath();
    const token = addMember(p, 'a@x.com');
    expect(token.startsWith('blx_')).toBe(true);
    const fileText = readFileSync(p, 'utf8');
    expect(fileText.includes(token)).toBe(false); // only the hash is stored
    expect(listMembers(p)).toEqual(['a@x.com']);
  });

  it('writes the members file mode 0600', () => {
    const p = newPath();
    addMember(p, 'a@x.com');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('authMember maps a valid presented key to its email and rejects others', () => {
    const p = newPath();
    const token = addMember(p, 'a@x.com');
    const store = loadMembers(p);
    expect(authMember(store, token)).toBe('a@x.com');
    expect(authMember(store, 'blx_wrong')).toBeNull();
    expect(authMember(store, '')).toBeNull();
  });

  it('removeMember revokes the token', () => {
    const p = newPath();
    const token = addMember(p, 'a@x.com');
    expect(removeMember(p, 'a@x.com')).toBe(true);
    expect(authMember(loadMembers(p), token)).toBeNull();
    expect(removeMember(p, 'a@x.com')).toBe(false); // already gone
  });
});
