// `npm run info` — funding wallet status report.
//
// Spins up the funding wallet, prints balance + leaves + addresses,
// then exits. Used to check that an L1 deposit has confirmed or a
// Spark transfer has landed.

import { loadEnv } from '../env.ts'
import { attachGlobalLocalStorage, patchBigIntToJson } from '../lib/storage-polyfill.ts'
import { createTestWallet } from '../lib/test-wallet.ts'

attachGlobalLocalStorage()
patchBigIntToJson()

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

  const balance = await wallet.getAvailableBalance()
  const leaves = await wallet.getLeaves()

  console.log(`Funding wallet (${env.sparkNetwork})`)
  console.log(`  spark addr     : ${wallet.sparkAddress}`)
  console.log(`  L1 deposit     : ${wallet.depositAddress}`)
  console.log(`  npub           : ${wallet.npub}`)
  console.log(`  identity pk    : ${wallet.sparkIdentityPubkey}`)
  console.log(`  balance        : ${balance} sats`)
  console.log(`  leaves         : ${leaves.length}`)
  if (leaves.length > 0) {
    for (const l of leaves.slice(0, 20)) {
      console.log(`    - ${l.id.slice(0, 18)}…  ${l.value} sats  (${l.status})`)
    }
    if (leaves.length > 20) {
      console.log(`    … +${leaves.length - 20} more`)
    }
  }

  await wallet.spark.cleanupConnections().catch(() => undefined)
}

main().catch((err) => {
  console.error('info failed:', err)
  process.exit(1)
})
