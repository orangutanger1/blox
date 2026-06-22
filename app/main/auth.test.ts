import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKeyVault, type SecureStorage } from './auth.js';

// Fake of Electron safeStorage: reversible (base64) so the round-trip is real
// without an OS keychain.
const fakeStorage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8').toString('base64') as unknown as Buffer,
  decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf8'),
};

const file = join(tmpdir(), `blox-vault-${Date.now()}.bin`);
afterEach(() => rmSync(file, { force: true }));

describe('createKeyVault', () => {
  it('round-trips a saved key', () => {
    const v = createKeyVault({ storage: fakeStorage, filePath: file });
    expect(v.loadKey()).toBeNull();
    v.saveKey('sk-abc');
    expect(v.loadKey()).toBe('sk-abc');
  });

  it('clears a key', () => {
    const v = createKeyVault({ storage: fakeStorage, filePath: file });
    v.saveKey('sk-abc');
    v.clearKey();
    expect(v.loadKey()).toBeNull();
  });

  it('reports status', () => {
    const v = createKeyVault({ storage: fakeStorage, filePath: file });
    expect(v.hasKey()).toBe(false);
    v.saveKey('sk-x');
    expect(v.hasKey()).toBe(true);
  });
});
