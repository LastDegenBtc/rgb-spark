// Esplora-compatible UTXO/block lookups for the familier deposit flow.
// Public mempool.space API — CORS is wide open (`access-control-allow-origin: *`),
// so this calls it directly from the browser, no backend proxy needed.
//
// REGTEST isn't supported here: there's no public regtest indexer, and a
// self-hosted esplora/electrs proved too resource-hungry to keep running.
// The familier funding flow needs a real chain anyway (a real UTXO with a
// real confirmation), so it targets TESTNET (free, no infra) and MAINNET —
// not REGTEST, unlike the rest of the app's network selector.

export type FamilierNetwork = 'MAINNET' | 'TESTNET';

function esploraBaseUrl(network: FamilierNetwork): string {
  switch (network) {
    case 'MAINNET':
      return 'https://mempool.space/api';
    case 'TESTNET':
      return 'https://mempool.space/testnet4/api';
  }
}

export interface AddressUtxo {
  txid: string;
  vout: number;
  /** Sats. */
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`esplora request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export async function fetchAddressUtxos(
  address: string,
  network: FamilierNetwork,
): Promise<AddressUtxo[]> {
  return getJson<AddressUtxo[]>(`${esploraBaseUrl(network)}/address/${address}/utxo`);
}

export async function fetchTipHeight(network: FamilierNetwork): Promise<number> {
  const res = await fetch(`${esploraBaseUrl(network)}/blocks/tip/height`);
  if (!res.ok) throw new Error(`tip height request failed: ${res.status}`);
  return Number(await res.text());
}

export interface DepositStatus {
  /** Set once an unconfirmed or confirmed UTXO is seen at the address. */
  utxo: AddressUtxo | null;
  /** 0 while unconfirmed/absent. */
  confirmations: number;
}

/**
 * Single poll tick: looks up the address's UTXOs (we only ever expect one —
 * the familier deposit — since the address is used exactly once) and
 * computes confirmations against the current tip. Confirmations math
 * mirrors Esplora's own convention: `tip - block_height + 1`.
 */
export async function pollDepositStatus(
  address: string,
  network: FamilierNetwork,
): Promise<DepositStatus> {
  const utxos = await fetchAddressUtxos(address, network);
  const utxo = utxos[0] ?? null;
  if (!utxo || !utxo.status.confirmed || utxo.status.block_height === undefined) {
    return { utxo, confirmations: 0 };
  }
  const tip = await fetchTipHeight(network);
  return { utxo, confirmations: tip - utxo.status.block_height + 1 };
}
