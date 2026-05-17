// scenario:smoke — verifies the harness primitives work end-to-end
// without touching any rgb-spark lib above the wallet layer.
//
// 1. Funding wallet boots and has ≥ 200 sats.
// 2. Derive alice + bob sub-wallets from the funding master.
// 3. Transfer 100 sats from funding → alice, 100 → bob (Spark→Spark).
// 4. Assert both have ≥ 100 sats available.
//
// This is the bare-minimum gate for any other scenario. If smoke
// fails, every trade scenario is going to fail too.

import { deriveSubSeedHex } from '../lib/derive-seed.ts'
import { createTestWallet } from '../lib/test-wallet.ts'
import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

const FUND_PER_WALLET = 100n
const REQUIRED_FUNDING = 250n // 2× FUND_PER_WALLET + headroom for SE fees

export default async function smoke(ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: ScenarioResult['steps'] = []

  // 1. funding-wallet balance gate
  const fundingBalance = await ctx.funding.getAvailableBalance()
  steps.push({
    name: `funding wallet ≥ ${REQUIRED_FUNDING} sats`,
    ok: fundingBalance >= REQUIRED_FUNDING,
    detail: `balance=${fundingBalance}`,
  })
  if (fundingBalance < REQUIRED_FUNDING) {
    return finish(false, steps, `fund the wallet with ≥ ${REQUIRED_FUNDING} sats and retry`)
  }

  // 2. derive sub-wallets
  // Master seed isn't on the funding TestWallet itself (it's in env),
  // but the funding wallet's nostrPrivkeyHex IS the master seed by
  // convention. We use it as the HMAC root for sub-derivation so
  // re-running the scenario lands on the SAME alice/bob wallets.
  const masterSeed = ctx.funding.nostrPrivkeyHex
  const aliceSeed = deriveSubSeedHex(masterSeed, 'smoke:alice')
  const bobSeed = deriveSubSeedHex(masterSeed, 'smoke:bob')
  const alice = await createTestWallet({ seedHex: aliceSeed, network: ctx.network, label: 'alice' })
  const bob = await createTestWallet({ seedHex: bobSeed, network: ctx.network, label: 'bob' })
  steps.push({
    name: 'derive alice + bob sub-wallets',
    ok: true,
    detail: `alice=${alice.sparkAddress.slice(0, 24)}…  bob=${bob.sparkAddress.slice(0, 24)}…`,
  })

  // 3. transfer funding → alice and funding → bob
  const transferOne = async (label: string, to: string): Promise<{ ok: boolean; detail: string }> => {
    try {
      const spark = ctx.funding.spark as unknown as {
        transfer: (opts: { receiverSparkAddress: string; amountSats: number }) => Promise<{ id: string }>
      }
      const r = await spark.transfer({
        receiverSparkAddress: to,
        amountSats: Number(FUND_PER_WALLET),
      })
      return { ok: true, detail: `transferId=${r.id.slice(0, 16)}…` }
    } catch (e) {
      return { ok: false, detail: `${label} transfer failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const aliceTx = await transferOne('alice', alice.sparkAddress)
  steps.push({ name: 'transfer 100 → alice', ok: aliceTx.ok, detail: aliceTx.detail })
  if (!aliceTx.ok) return finish(false, steps, 'funding→alice transfer broken')
  const bobTx = await transferOne('bob', bob.sparkAddress)
  steps.push({ name: 'transfer 100 → bob', ok: bobTx.ok, detail: bobTx.detail })
  if (!bobTx.ok) return finish(false, steps, 'funding→bob transfer broken')

  // 4. assert recipients see the sats. Spark transfers land
  //    eventually-consistent; poll up to 60s.
  const waitForBalance = async (w: typeof alice, atLeast: bigint): Promise<bigint> => {
    const deadline = Date.now() + 60_000
    let balance = await w.getAvailableBalance()
    while (balance < atLeast && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 3000))
      balance = await w.getAvailableBalance()
    }
    return balance
  }
  const aliceBal = await waitForBalance(alice, FUND_PER_WALLET)
  steps.push({
    name: 'alice receives ≥ 100 sats',
    ok: aliceBal >= FUND_PER_WALLET,
    detail: `balance=${aliceBal}`,
  })
  const bobBal = await waitForBalance(bob, FUND_PER_WALLET)
  steps.push({
    name: 'bob receives ≥ 100 sats',
    ok: bobBal >= FUND_PER_WALLET,
    detail: `balance=${bobBal}`,
  })

  // Cleanup connections so the process exits cleanly.
  await alice.spark.cleanupConnections().catch(() => undefined)
  await bob.spark.cleanupConnections().catch(() => undefined)

  const allOk = steps.every((s) => s.ok)
  return finish(allOk, steps, allOk ? 'harness primitives are healthy' : 'see failing steps above')
}

function finish(passed: boolean, steps: ScenarioResult['steps'], summary: string): ScenarioResult {
  return { passed, steps, summary }
}
