// L1 Bitcoin key for the familier's RGB-binding UTXO — a second
// derivation off the same root seed as lib/nostrKey.ts, deliberately
// separate from the Spark `depositAddress` (sparkWallet.ts).
//
// Why not reuse the Spark deposit address: it's a single-use P2TR
// address that gets swept into the Spark statechain once `claimDeposit`
// is called, and isn't meant to stay a solo-resignable L1 UTXO. A
// familier's genesis seal needs the opposite — a plain UTXO the player
// can re-sign alone, with no Spark operator cooperation, for a future
// RGB transfer witness tx. Hence: one seed, two unrelated derivations.

import { HDKey } from '@scure/bip32';
import { getAddress, NETWORK, TEST_NETWORK, type BTC_NETWORK } from '@scure/btc-signer';

type Network = 'MAINNET' | 'REGTEST' | 'TESTNET';

// Regtest isn't exported by @scure/btc-signer (mainnet/testnet only) —
// same params as testnet, different bech32 HRP ("bcrt1...").
const REGTEST_NETWORK: BTC_NETWORK = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

// Arbitrary path, just needs to never collide with NIP-06 (m/44'/1237'/...)
// or anything Spark derives internally. Not a registered BIP — there's no
// shared wallet to interoperate with here, the key only needs to round-trip
// inside this app.
const FAMILIER_BTC_PATH = "m/86'/1237'/0'/0/0";

export interface FamilierKey {
  /** 32-byte raw secp256k1 private key — signs the future RGB-transfer
   *  witness tx that spends this UTXO. Never sent anywhere; kept only
   *  long enough to derive the address and, later, to sign. */
  privateKey: Uint8Array;
  /** P2TR address (network-appropriate HRP) to show the player for the
   *  BTC deposit that becomes their familier's genesis-seal UTXO. */
  address: string;
}

function btcNetworkFor(network: Network): BTC_NETWORK {
  switch (network) {
    case 'MAINNET':
      return NETWORK;
    case 'TESTNET':
      return TEST_NETWORK;
    case 'REGTEST':
      return REGTEST_NETWORK;
  }
}

/**
 * Derives the dedicated familier-funding key from the app's root seed
 * (same bytes as the Nostr privkey / Spark seed — see nostrKey.ts).
 * Deterministic: calling this again with the same seed/network always
 * yields the same address, so reloading the page doesn't orphan a
 * deposit already in flight.
 */
export function deriveFamilierKey(rootSeed: Uint8Array, network: Network): FamilierKey {
  const root = HDKey.fromMasterSeed(rootSeed);
  const child = root.derive(FAMILIER_BTC_PATH);
  if (!child.privateKey) throw new Error('familier BTC derivation produced no private key');
  const address = getAddress('tr', child.privateKey, btcNetworkFor(network));
  if (!address) throw new Error('failed to derive familier P2TR address');
  return { privateKey: child.privateKey, address };
}
