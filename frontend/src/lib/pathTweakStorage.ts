// localStorage persistence for Spark-UTK path tweaks.
//
// pathTweaks aren't secret — sourcePath is a leaf UUID and msg is the RGB
// commitment that's revealed in every proof — but they're useless without
// the wallet seed they reference, so we store them in plain JSON. The
// wallet seed itself stays PIN-encrypted in secretVault.ts.
//
// Per-wallet scoping is via the npub stored alongside the entries; on
// boot we only restore tweaks whose npub matches the wallet we just
// unlocked, so re-logging-in with a different nsec doesn't surface
// tweaks from another identity.

import {
  type PathTweakEntry,
  restorePathTweaks,
  setPathTweaksPersistenceListener,
} from './rgbAwareSigner';

const STORAGE_KEY = 'rgbspark.pathTweaks.v1';

interface PersistedShape {
  npub: string;
  entries: Array<{
    currentLeafId: string;
    sourcePath: string;
    msgHex: string;
    uBaseHex: string;
    consignmentHex?: string;
    transitionHex?: string;
    prevGenesisHex?: string;
  }>;
}

function bytesToHex(u: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function readRaw(): PersistedShape | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedShape;
  } catch {
    return null;
  }
}

function writeRaw(payload: PersistedShape | null): void {
  if (payload === null || payload.entries.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/**
 * Restore pathTweaks for the given npub from localStorage, then wire a
 * listener that persists every subsequent mutation. Call once per wallet
 * boot, after the user is authenticated.
 */
export function attachPathTweakStorage(npub: string): void {
  // Restore matching tweaks. Entries persisted before uBase was added (pre
  // session 6) won't have uBaseHex; we skip those rather than guessing.
  const persisted = readRaw();
  if (persisted && persisted.npub === npub) {
    const usable = persisted.entries.filter((e) => typeof e.uBaseHex === 'string' && e.uBaseHex.length === 66);
    restorePathTweaks(
      usable.map((e) => ({
        currentLeafId: e.currentLeafId,
        sourcePath: e.sourcePath,
        msg: hexToBytes(e.msgHex),
        uBase: hexToBytes(e.uBaseHex),
        consignmentHex: e.consignmentHex,
        transitionHex: e.transitionHex,
        prevGenesisHex: e.prevGenesisHex,
      })),
    );
  } else {
    restorePathTweaks([]);
  }

  // Persist on every mutation.
  setPathTweaksPersistenceListener((map: ReadonlyMap<string, PathTweakEntry>) => {
    const entries = Array.from(map.entries()).map(([currentLeafId, e]) => ({
      currentLeafId,
      sourcePath: e.sourcePath,
      msgHex: bytesToHex(e.msg),
      uBaseHex: bytesToHex(e.uBase),
      ...(e.consignmentHex ? { consignmentHex: e.consignmentHex } : {}),
      ...(e.transitionHex ? { transitionHex: e.transitionHex } : {}),
      ...(e.prevGenesisHex ? { prevGenesisHex: e.prevGenesisHex } : {}),
    }));
    writeRaw({ npub, entries });
  });
}

/**
 * Disconnect the storage layer — call on wallet reset / forget. Clears the
 * in-memory map AND the localStorage entry.
 */
export function detachPathTweakStorage(): void {
  setPathTweaksPersistenceListener(null);
  restorePathTweaks([]);
  writeRaw(null);
}
