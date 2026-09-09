// API-key storage. Default backend is the OS keychain (@napi-rs/keyring);
// memoryStore is the test double and the seam for a future 0600-file fallback.
// Secrets NEVER touch workspace.json or any git-tracked file.
import { Entry } from '@napi-rs/keyring';

export const SERVICE = 'doklo';

export interface CredentialStore {
  get(profileId: string): string | null;
  set(profileId: string, key: string): void;
  delete(profileId: string): boolean;
}

export function keychainStore(): CredentialStore {
  return {
    get(profileId) {
      return new Entry(SERVICE, profileId).getPassword();
    },
    set(profileId, key) {
      new Entry(SERVICE, profileId).setPassword(key);
    },
    delete(profileId) {
      return new Entry(SERVICE, profileId).deletePassword();
    },
  };
}

export function memoryStore(seed: Record<string, string> = {}): CredentialStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get(profileId) {
      return map.get(profileId) ?? null;
    },
    set(profileId, key) {
      map.set(profileId, key);
    },
    delete(profileId) {
      return map.delete(profileId);
    },
  };
}
