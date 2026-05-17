// scenario:htlc-default-signer — same HTLC swap as htlc-only but with
// the SDK's stock `DefaultSparkSigner` instead of our custom
// `RgbAwareSparkSigner`. Isolates whether the rgb-aware signer is
// responsible for the claim-hydration failure we see in Node.

import { deriveSubSeedHex } from '../lib/derive-seed.ts'
import { createTestWallet, type TestWallet } from '../lib/test-wallet.ts'
import { runSellerFlow, runBuyerFlow, newPreimagePair } from '@rgb-spark/lib/htlcSwap'
import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

const PRICE_SATS = 150
const PER_WALLET_FUND = 300n
const BUYER_EXPIRY_MS = 5 * 60_000
const SELLER_EXPIRY_MS = 15 * 60_000

interface SparkTransferAPI {
  transfer: (opts: { receiverSparkAddress: string; amountSats: number }) => Promise<{ id: string }>
}

async function fund(master: TestWallet, target: TestWallet, amountSats: number): Promise<void> {
  const spark = master.spark as unknown as SparkTransferAPI
  await spark.transfer({ receiverSparkAddress: target.sparkAddress, amountSats })
}

async function waitFor(w: TestWallet, atLeast: bigint, timeoutMs = 60_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs
  let b = await w.getAvailableBalance()
  while (b < atLeast && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    b = await w.getAvailableBalance()
  }
  return b
}

export default async function htlcDefaultSigner(ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: ScenarioResult['steps'] = []

  // Distinct seeds from smoke:* and probe:* so the wallets don't
  // share state with the rgb-aware-signer runs.
  const alice = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'default-signer:alice'),
    network: ctx.network,
    label: 'alice',
    signerKind: 'default',
  })
  const bob = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'default-signer:bob'),
    network: ctx.network,
    label: 'bob',
    signerKind: 'default',
  })
  steps.push({ name: 'wallets created with DefaultSparkSigner', ok: true })

  if ((await alice.getAvailableBalance()) < PER_WALLET_FUND) await fund(ctx.funding, alice, Number(PER_WALLET_FUND))
  if ((await bob.getAvailableBalance()) < PER_WALLET_FUND) await fund(ctx.funding, bob, Number(PER_WALLET_FUND))
  const aliceBal = await waitFor(alice, PER_WALLET_FUND)
  const bobBal = await waitFor(bob, PER_WALLET_FUND)
  steps.push({
    name: 'fund alice + bob',
    ok: aliceBal >= PER_WALLET_FUND && bobBal >= PER_WALLET_FUND,
    detail: `alice=${aliceBal}  bob=${bobBal}`,
  })

  const { preimage, paymentHash } = newPreimagePair()
  const aliceLeaves = await alice.spark.getLeaves(true)
  const carrier = [...aliceLeaves].sort((a, b) => Number(a.value ?? 0) - Number(b.value ?? 0))[0]
  if (!carrier) return { passed: false, steps, summary: 'alice has no leaves' }
  const bobLeaves = await bob.spark.getLeaves(true)
  const sorted = [...bobLeaves].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
  let acc = 0
  const bobSatsLeaves: typeof bobLeaves = []
  for (const l of sorted) {
    if (acc >= PRICE_SATS) break
    bobSatsLeaves.push(l)
    acc += Number(l.value ?? 0)
  }
  if (acc < PRICE_SATS) return { passed: false, steps, summary: `bob can't reach ${PRICE_SATS} sats` }

  const t0 = Date.now()
  const sellerPromise = runSellerFlow(alice.spark, {
    assetLeaves: [carrier] as unknown as Parameters<typeof runSellerFlow>[1]['assetLeaves'],
    counterpartyPubkey: Buffer.from(bob.sparkIdentityPubkey, 'hex'),
    expectedSatsFromBuyer: PRICE_SATS,
    expiryTime: new Date(Date.now() + SELLER_EXPIRY_MS),
    preimage,
    pollIntervalMs: 2_000,
    onState: (s) => console.log(`  [seller ${((Date.now() - t0) / 1000).toFixed(1).padStart(5, ' ')}s] ${s.phase}: ${s.message}`),
  })
  const buyerPromise = runBuyerFlow(bob.spark, {
    satsLeaves: bobSatsLeaves as unknown as Parameters<typeof runBuyerFlow>[1]['satsLeaves'],
    counterpartyPubkey: Buffer.from(alice.sparkIdentityPubkey, 'hex'),
    paymentHash,
    expiryTime: new Date(Date.now() + BUYER_EXPIRY_MS),
    pollIntervalMs: 2_000,
    onState: (s) => console.log(`  [buyer  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5, ' ')}s] ${s.phase}: ${s.message}`),
  })

  const [sellerResult, buyerResult] = await Promise.all([sellerPromise, buyerPromise])

  steps.push({
    name: 'seller outcome',
    ok: sellerResult.outcome === 'completed',
    detail: sellerResult.outcome + (sellerResult.state.cause ? ` — ${sellerResult.state.cause}` : ''),
  })
  steps.push({
    name: 'buyer outcome',
    ok: buyerResult.outcome === 'completed',
    detail: buyerResult.outcome + (buyerResult.claimedLeafId ? ` claimedLeafId=${buyerResult.claimedLeafId.slice(0, 18)}…` : ''),
  })

  await alice.spark.cleanupConnections().catch(() => undefined)
  await bob.spark.cleanupConnections().catch(() => undefined)

  const allOk = steps.every((s) => s.ok)
  return {
    passed: allOk,
    steps,
    summary: allOk
      ? 'DefaultSparkSigner works — RgbAwareSparkSigner was masking the leaves'
      : 'fails identically with DefaultSparkSigner — signer is NOT the cause; bug is in SDK or our flow setup',
  }
}
