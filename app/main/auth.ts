// app/main/auth.ts
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

// The subset of Electron's safeStorage we use; injected so tests run headless.
export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export interface VaultDeps {
  storage: SecureStorage;
  filePath: string; // app.getPath('userData') + '/key.bin' in production
}

// Stores the API key encrypted at rest via the OS credential backend. The key
// never touches plaintext disk or logs.
export function createKeyVault(deps: VaultDeps) {
  return {
    hasKey: () => existsSync(deps.filePath),
    saveKey(key: string): void {
      if (!deps.storage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable');
      writeFileSync(deps.filePath, deps.storage.encryptString(key));
    },
    loadKey(): string | null {
      if (!existsSync(deps.filePath)) return null;
      try {
        return deps.storage.decryptString(readFileSync(deps.filePath));
      } catch {
        return null;
      }
    },
    clearKey(): void {
      rmSync(deps.filePath, { force: true });
    },
  };
}
