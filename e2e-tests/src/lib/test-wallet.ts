// TestWallet — a single isolated SparkWallet + nostr identity tuple
// for use inside an e2e scenario.
//
// We bypass the sprk/rgb-spark `initSparkWallet` wrapper because that
// one is a singleton (one wallet per Node process). For multi-wallet
// scenarios we need each TestWallet to own its own SDK instance, so
// we call `SparkWallet.initialize` directly and keep the resulting
// SparkWallet on the TestWallet object.
//
// Helpers that the rgb-spark libs expect (e.g. `wallet.getBalance()`,
// `wallet.getLeaves(true)`) are exposed both as direct SDK passthroughs
// AND through a small explicit surface so call sites in scenarios stay
// readable.

import { SparkWallet } from '@buildonspark/spark-sdk'
import { nip19 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { RgbAwareSparkSigner } from '@rgb-spark/lib/rgbAwareSigner'

export type SparkNetwork = 'MAINNET' | 'TESTNET' | 'REGTEST'

export interface TestWalletInit {
  /** Hex-encoded 32-byte seed. Doubles as the nostr secp256k1 privkey
   *  (matches the sprk/rgb-spark frontend convention). */
  seedHex: string
  network: SparkNetwork
  /** Human-readable label for log lines, e.g. 'alice', 'bob'. Not
   *  used for any cryptographic purpose. */
  label: string
}

export interface TestWallet {
  label: string
  spark: SparkWallet
  network: SparkNetwork
  /** 64-hex schnorr privkey for orderbook + envelope signing. */
  nostrPrivkeyHex: string
  /** Bech32 npub matching `nostrPrivkeyHex`. */
  npub: string
  /** 33-byte hex compressed pubkey, the Spark identity (= what
   *  HTLC counterparty locks to). */
  sparkIdentityPubkey: string
  /** Bech32m Spark address (= where Spark→Spark transfers go). */
  sparkAddress: string
  /** Fresh single-use L1 deposit address. Only useful when funding
   *  from on-chain BTC. */
  depositAddress: string
  /** Re-run initialization with the same seed (used to flush in-memory
   *  SDK state after a test that mutates a lot). */
  reinit: () => Promise<void>
  /** Convenience: returns the SDK's fresh-from-coordinator total. */
  getAvailableBalance: () => Promise<bigint>
  /** Convenience: returns the wallet's current Spark leaves. */
  getLeaves: () => Promise<Array<{ id: string; value: number; status: string }>>
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex must have even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

/** Spin up a SparkWallet using the RgbAwareSparkSigner so the wallet
 *  can later participate in Spark-UTK keytweak flows. The signer's
 *  pathTweak map is empty by default; scenarios that exercise the
 *  rgb-binding path will populate it via the lib API. */
export async function createTestWallet(init: TestWalletInit): Promise<TestWallet> {
  const seed = hexToBytes(init.seedHex)
  const signer = new RgbAwareSparkSigner()
  // SparkWallet.initialize is a generic static; pass through as
  // `unknown` to keep our import surface tight without exporting the
  // SDK's internal signer type from here.
  const init$ = (SparkWallet as unknown as {
    initialize: (opts: {
      mnemonicOrSeed: Uint8Array
      signer?: unknown
      options: { network: SparkNetwork }
    }) => Promise<{ wallet: SparkWallet }>
  }).initialize({
    mnemonicOrSeed: seed,
    signer,
    options: { network: init.network },
  })
  const { wallet } = await init$
  const [sparkAddress, depositAddress, identityPkRaw] = await Promise.all([
    wallet.getSparkAddress(),
    wallet.getSingleUseDepositAddress(),
    wallet.getIdentityPublicKey(),
  ])
  const sparkIdentityPubkey =
    typeof identityPkRaw === 'string' ? identityPkRaw : bytesToHex(identityPkRaw as Uint8Array)

  // nostr identity: same 32-byte seed acts as the schnorr privkey.
  const nostrPrivkeyHex = init.seedHex
  const xOnlyPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(nostrPrivkeyHex)))
  const npub = nip19.npubEncode(xOnlyPubkey)

  return {
    label: init.label,
    spark: wallet,
    network: init.network,
    nostrPrivkeyHex,
    npub,
    sparkIdentityPubkey,
    sparkAddress,
    depositAddress,
    async reinit() {
      // SDK doesn't expose a full reset; the closest we can do is
      // re-initialize. Tests that need a hard refresh should create
      // a NEW TestWallet rather than reuse this one.
      await wallet.cleanupConnections().catch(() => undefined)
    },
    async getAvailableBalance() {
      const { balance } = await wallet.getBalance()
      return balance
    },
    async getLeaves() {
      const leaves = await wallet.getLeaves(true)
      return leaves.map((l) => ({
        id: String(l.id),
        value: Number(l.value ?? 0),
        status: String(l.status ?? ''),
      }))
    },
  }
}
