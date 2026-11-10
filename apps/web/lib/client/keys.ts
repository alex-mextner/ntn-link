/**
 * Owner keys live in localStorage, one entry per origin + workspace, so a key issued by one
 * deployment is never offered to another and one workspace's key never leaks to a sibling.
 * The claimToken is deliberately NOT stored here: it stays in memory (see flow.ts).
 */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'ntn-link:owner-key:';

export function keyName(origin: string, workspace: string): string {
  return `${PREFIX}${origin}:${workspace}`;
}

export function loadKey(
  storage: KeyStorage | null,
  origin: string,
  workspace: string,
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(keyName(origin, workspace));
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to persist (private mode, quota). */
export function saveKey(
  storage: KeyStorage | null,
  origin: string,
  workspace: string,
  ownerKey: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(keyName(origin, workspace), ownerKey);
    return true;
  } catch {
    return false;
  }
}

export function forgetKey(storage: KeyStorage | null, origin: string, workspace: string): void {
  try {
    storage?.removeItem(keyName(origin, workspace));
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

/**
 * Forgets a key only if storage still holds exactly the key a request was made with, so a late
 * "unauthorized" for an old key can never erase a newer key saved in the meantime.
 */
export function forgetKeyIfCurrent(
  storage: KeyStorage | null,
  origin: string,
  workspace: string,
  usedKey: string,
): void {
  if (loadKey(storage, origin, workspace) === usedKey) forgetKey(storage, origin, workspace);
}

/** Workspaces of this origin that have a stored key. */
export function storedWorkspaces(
  storage: (KeyStorage & { length: number; key(index: number): string | null }) | null,
  origin: string,
): string[] {
  if (!storage) return [];
  const prefix = `${PREFIX}${origin}:`;
  const found: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (name?.startsWith(prefix)) found.push(name.slice(prefix.length));
    }
  } catch {
    return [];
  }
  return found.toSorted();
}
