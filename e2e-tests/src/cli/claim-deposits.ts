// `npm run claim` — claim any unclaimed L1 deposits into Spark leaves.
//
// Only relevant for L1-funded wallets. Spark→Spark transfers land
// directly as available leaves, no claim needed.
//
// The SDK exposes `getUnusedDepositAddresses()` for tracking; an
// unused address that has received a tx becomes claimable via
// `claimDeposit(txid)`. We poll the user's relevant addresses and
// claim everything we can.

import { loadEnv } from '../env.ts'
import { attachGlobalLocalStorage, patchBigIntToJson } from '../lib/storage-polyfill.ts'
import { createTestWallet } from '../lib/test-wallet.ts'

attachGlobalLocalStorage()
patchBigIntToJson()

interface SparkWithDeposit {
  getUnusedDepositAddresses: () => Promise<string[]>
  claimDeposit: (txid: string) => Promise<unknown>
  // Spark SDK exposes a Bitcoin-tx-lookup helper indirectly; we expect
  // the caller to provide txids manually for now. A future iteration
  // can wire a mempool/electrum lookup so claims are fully automatic.
}

async function main() {
  const env = loadEnv()
  if (!env.fundingSeedHex) {
    console.error('No FUNDING_SEED_HEX in .env. Run `npm run setup` first.')
    process.exit(2)
  }
  const wallet = await createTestWallet({
    seedHex: env.fundingSeedHex,
    network: env.sparkNetwork,
    label: 'funding',
  })
  const spark = wallet.spark as unknown as SparkWithDeposit

  const txids = process.argv.slice(2)
  if (txids.length === 0) {
    const addrs = await spark.getUnusedDepositAddresses()
    console.log('Unused deposit addresses on this wallet:')
    for (const a of addrs) console.log(`  ${a}`)
    console.log('')
    console.log('Pass txids to claim:  npm run claim -- <txid1> [<txid2> …]')
    return
  }

  for (const txid of txids) {
    process.stdout.write(`claiming ${txid.slice(0, 16)}…  `)
    try {
      const r = await spark.claimDeposit(txid)
      console.log('OK', Array.isArray(r) ? `(${r.length} leaves)` : '')
    } catch (e) {
      console.log('FAIL', e instanceof Error ? e.message : String(e))
    }
  }

  const balance = await wallet.getAvailableBalance()
  console.log(`balance now: ${balance} sats`)

  await wallet.spark.cleanupConnections().catch(() => undefined)
}

main().catch((err) => {
  console.error('claim failed:', err)
  process.exit(1)
})
