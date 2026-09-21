export type DokViewPreference = 'system' | 'evidence';

const KEYS: Record<DokViewPreference, string> = {
  system: 'doklo.studio.detail.showSystemProcesses.v1',
  evidence: 'doklo.studio.detail.showProcessEvidence.v1',
};

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readDokViewPreference(storage: PreferenceStorage, preference: DokViewPreference): boolean {
  try {
    return storage.getItem(KEYS[preference]) === 'true';
  } catch {
    return false;
  }
}

export function writeDokViewPreference(storage: PreferenceStorage, preference: DokViewPreference, value: boolean): void {
  try {
    storage.setItem(KEYS[preference], String(value));
  } catch {
    // Keep the viewer usable when browser storage is unavailable.
  }
}
