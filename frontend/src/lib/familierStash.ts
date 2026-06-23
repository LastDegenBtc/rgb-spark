// Persistent record of UDAs minted from FamilierPage. Separate from
// rgbStash.ts (which is NIA-shaped — has a `supply` field that doesn't
// apply to a one-of-one UDA) rather than overloading that type.
//
// Why this needs to exist at all: the consignment bytes aren't
// re-derivable from the seed. Re-minting with the same seed/UTXO
// produces a *different* contractId (timestamp differs), so losing
// this record loses the specific asset's proof, even with the nsec
// safely backed up.

const STORAGE_KEY = 'frognesis_familier_stash';

export interface FamilierEntry {
  contractId: string;
  consignmentHex: string;
  ticker: string;
  name: string;
  tokenIndex: number;
  utxo: { txid: string; vout: number };
  network: string;
  mintedAt: string;
}

export function loadFamiliers(): FamilierEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FamilierEntry[]) : [];
  } catch {
    return [];
  }
}

export function addFamilier(entry: FamilierEntry): FamilierEntry[] {
  const all = [...loadFamiliers(), entry];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  return all;
}

export interface FamilierBackup {
  nsec: string;
  familiers: FamilierEntry[];
}

/** Everything needed to fully restore on a different browser/machine:
 *  the seed (re-derives the deposit address + any future signing) and
 *  the minted consignments (not re-derivable — see file header). */
export function exportBackup(nsec: string): FamilierBackup {
  return { nsec, familiers: loadFamiliers() };
}

export function downloadBackup(nsec: string): void {
  const backup = exportBackup(nsec);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `frognesis-familier-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseBackup(json: string): FamilierBackup {
  const parsed = JSON.parse(json) as Partial<FamilierBackup>;
  if (typeof parsed.nsec !== 'string' || !Array.isArray(parsed.familiers)) {
    throw new Error('not a valid familier backup file');
  }
  return { nsec: parsed.nsec, familiers: parsed.familiers };
}

/** Restores a backup's familiers into localStorage. Caller is
 *  responsible for booting the wallet from `backup.nsec` separately. */
export function restoreFamiliers(familiers: FamilierEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(familiers));
}
