// `npm run scenario:<name>` dispatcher.
//
// Each scenario is a default-exported async function that receives an
// initialized funding wallet and returns a result object. The runner
// formats it for console output and exits with the right code.

import { loadEnv } from '../env.ts'
import { attachGlobalLocalStorage, patchBigIntToJson } from '../lib/storage-polyfill.ts'
import { createTestWallet, type TestWallet } from '../lib/test-wallet.ts'

attachGlobalLocalStorage()
patchBigIntToJson()

export interface ScenarioContext {
  funding: TestWallet
  relayBaseUrl: string
  network: 'MAINNET' | 'TESTNET' | 'REGTEST'
}

export interface ScenarioResult {
  passed: boolean
  steps: Array<{ name: string; ok: boolean; detail?: string }>
  summary: string
}

async function main() {
  const scenarioName = process.argv[2]
  if (!scenarioName) {
    console.error('Usage: tsx run-scenario.ts <scenario-name>')
    process.exit(2)
  }
  const env = loadEnv()
  if (!env.fundingSeedHex) {
    console.error('No FUNDING_SEED_HEX in .env. Run `npm run setup` first.')
    process.exit(2)
  }
  const funding = await createTestWallet({
    seedHex: env.fundingSeedHex,
    network: env.sparkNetwork,
    label: 'funding',
  })

  const scenario = await import(`../scenarios/${scenarioName}.ts`)
  if (typeof scenario.default !== 'function') {
    console.error(`Scenario ${scenarioName} does not export a default function.`)
    process.exit(2)
  }
  const ctx: ScenarioContext = {
    funding,
    relayBaseUrl: env.relayBaseUrl,
    network: env.sparkNetwork,
  }

  console.log(`▶ running scenario: ${scenarioName}`)
  const result: ScenarioResult = await scenario.default(ctx)
  console.log('')
  for (const s of result.steps) {
    console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`)
  }
  console.log('')
  console.log(result.passed ? '✓ PASS' : '✗ FAIL')
  console.log(`  ${result.summary}`)

  await funding.spark.cleanupConnections().catch(() => undefined)
  process.exit(result.passed ? 0 : 1)
}

main().catch((err) => {
  console.error('scenario runner failed:', err)
  process.exit(1)
})
