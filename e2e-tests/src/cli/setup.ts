// `npm run setup` — first-run bootstrap.
//
// Generates the funding wallet's seed if missing, persists it to .env,
// initializes the SparkWallet, and prints the spark address + L1
// deposit address. The user funds whichever they prefer (Spark
// transfer from another wallet = instant; L1 deposit = needs confs +
// `npm run claim`).
//
// Idempotent: re-running prints the existing addresses without
// regenerating the seed.

import { randomBytes } from 'node:crypto'
import { loadEnv, patchEnv } from '../env.ts'
import { attachGlobalLocalStorage } from '../lib/storage-polyfill.ts'
import { createTestWallet } from '../lib/test-wallet.ts'

attachGlobalLocalStorage()

async function main() {
  let env = loadEnv()
  if (!env.fundingSeedHex) {
    const fresh = Buffer.from(randomBytes(32)).toString('hex')
    patchEnv({ FUNDING_SEED_HEX: fresh })
    env = loadEnv()
    console.log('Generated fresh funding seed and saved to .env (gitignored).')
  } else {
    console.log('Re-using funding seed from .env.')
  }

  console.log(`Spinning up funding wallet on ${env.sparkNetwork}…`)
  const wallet = await createTestWallet({
    seedHex: env.fundingSeedHex!,
    network: env.sparkNetwork,
    label: 'funding',
  })

  const balance = await wallet.getAvailableBalance()
  const leaves = await wallet.getLeaves()

  console.log('')
  console.log('═══ FUND THIS WALLET ═══')
  console.log('')
  console.log(`Spark address  : ${wallet.sparkAddress}`)
  console.log(`L1 deposit addr: ${wallet.depositAddress}`)
  console.log('')
  console.log(`Network        : ${env.sparkNetwork}`)
  console.log(`npub           : ${wallet.npub}`)
  console.log(`identity pk    : ${wallet.sparkIdentityPubkey}`)
  console.log('')
  console.log(`Current balance: ${balance} sats (${leaves.length} leaves)`)
  console.log('')
  console.log('Send sats either:')
  console.log(`  • Spark→Spark (instant) — to ${wallet.sparkAddress}`)
  console.log(`  • L1 BTC (needs ${env.sparkNetwork === 'MAINNET' ? '6' : '1'} confs + \`npm run claim\`)`)
  console.log('')
  console.log('Verify funded:  npm run info')
  console.log('')

  await wallet.spark.cleanupConnections().catch(() => undefined)
}

main().catch((err) => {
  console.error('setup failed:', err)
  process.exit(1)
})
