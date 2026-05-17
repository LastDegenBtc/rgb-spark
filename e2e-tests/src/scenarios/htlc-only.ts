// scenario:htlc-only — pure Spark HTLC atomic swap, no RGB layer.
//
// Validates `runSellerFlow` + `runBuyerFlow` from rgb-spark/lib/htlcSwap
// move value bidirectionally between two wallets atomically. If this
// scenario fails, the HTLC primitive itself is broken and every
// trade-flow scenario above it is unreliable.
//
// Trade shape:
//   - alice locks a 1-sat carrier leaf to bob under H (asset side).
//   - bob locks `priceSats` to alice under H (price side).
//   - alice reveals preimage → both legs settle.
// Post-conditions:
//   - alice.balance went UP by priceSats (-1 sat for carrier).
//   - bob.balance went DOWN by priceSats (+1 sat from carrier).
//   - bob holds a new leaf with the same id as the asset leaf alice
//     locked (F2.1 path — claimedLeafId).

import { deriveSubSeedHex } from '../lib/derive-seed.ts'
import { createTestWallet, type TestWallet } from '../lib/test-wallet.ts'
import {
  runSellerFlow,
  runBuyerFlow,
  newPreimagePair,
} from '@rgb-spark/lib/htlcSwap'
import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

// Sized for safety + above-dust:
//   - PRICE_SATS: what bob pays alice. ≥ 100 ([[feedback-trade-amounts-above-dust]]).
//   - PER_WALLET_FUND: each side seeded with enough to lock + carry.
const PRICE_SATS = 150
const PER_WALLET_FUND = 300n // 2× headroom over PRICE_SATS

// HTLC expiries — buyer must expire BEFORE seller so seller has a
// safety window to claim after revealing. Both well past any plausible
// SDK polling delay.
const BUYER_EXPIRY_MS = 5 * 60_000
const SELLER_EXPIRY_MS = 15 * 60_000

interface SparkTransferAPI {
  transfer: (opts: { receiverSparkAddress: string; amountSats: number }) => Promise<{ id: string }>
}

async function fundFromMaster(
  master: TestWallet,
  target: TestWallet,
  amountSats: number,
): Promise<void> {
  const spark = master.spark as unknown as SparkTransferAPI
  await spark.transfer({ receiverSparkAddress: target.sparkAddress, amountSats })
}

async function waitForBalance(w: TestWallet, atLeast: bigint, timeoutMs = 60_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs
  let bal = await w.getAvailableBalance()
  while (bal < atLeast && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 3000))
    bal = await w.getAvailableBalance()
  }
  return bal
}

export default async function htlcOnly(ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: ScenarioResult['steps'] = []

  // 1. Derive alice + bob deterministically. Reusing the smoke names
  //    keeps state across runs idempotent — alice/bob built up sats
  //    via the smoke scenario already; we top them up only if short.
  const alice = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'smoke:alice'),
    network: ctx.network,
    label: 'alice',
  })
  const bob = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'smoke:bob'),
    network: ctx.network,
    label: 'bob',
  })
  steps.push({
    name: 'derive alice + bob',
    ok: true,
    detail: `alice.pk=${alice.sparkIdentityPubkey.slice(0, 16)}…  bob.pk=${bob.sparkIdentityPubkey.slice(0, 16)}…`,
  })

  // 2. Top up alice and bob if needed.
  const aliceBalBefore = await alice.getAvailableBalance()
  const bobBalBefore = await bob.getAvailableBalance()
  if (aliceBalBefore < PER_WALLET_FUND) {
    const need = Number(PER_WALLET_FUND - aliceBalBefore)
    await fundFromMaster(ctx.funding, alice, need)
  }
  if (bobBalBefore < PER_WALLET_FUND) {
    const need = Number(PER_WALLET_FUND - bobBalBefore)
    await fundFromMaster(ctx.funding, bob, need)
  }
  const aliceFunded = await waitForBalance(alice, PER_WALLET_FUND)
  const bobFunded = await waitForBalance(bob, PER_WALLET_FUND)
  steps.push({
    name: `top-up alice + bob to ≥ ${PER_WALLET_FUND} sats`,
    ok: aliceFunded >= PER_WALLET_FUND && bobFunded >= PER_WALLET_FUND,
    detail: `alice=${aliceFunded}  bob=${bobFunded}`,
  })
  if (aliceFunded < PER_WALLET_FUND || bobFunded < PER_WALLET_FUND) {
    return { passed: false, steps, summary: 'one side failed to receive top-up; abort' }
  }

  // 3. Shared preimage. The "seller" side (alice in this scenario,
  //    role-named for symmetry with the lib API) holds it.
  const { preimage, paymentHash } = newPreimagePair()

  // 4. Pick alice's smallest leaf as the asset-carrier. 1 sat would
  //    be ideal but we use whatever the wallet has; the SDK rejects
  //    sub-dust outright so a tiny leaf is fine.
  const aliceLeaves = await alice.spark.getLeaves(true)
  const carrier = [...aliceLeaves].sort(
    (a, b) => Number(a.value ?? 0) - Number(b.value ?? 0),
  )[0]
  if (!carrier) {
    return {
      passed: false,
      steps: [...steps, { name: 'alice has at least one leaf', ok: false }],
      summary: 'alice wallet empty after top-up — funding flow may be broken',
    }
  }
  steps.push({
    name: `alice asset-carrier leaf chosen`,
    ok: true,
    detail: `id=${String(carrier.id).slice(0, 18)}…  value=${carrier.value}`,
  })

  // 5. Run both flows in parallel.
  const sellerExpiry = new Date(Date.now() + SELLER_EXPIRY_MS)
  const buyerExpiry = new Date(Date.now() + BUYER_EXPIRY_MS)
  const counterpartyOfAlice = Buffer.from(bob.sparkIdentityPubkey, 'hex')
  const counterpartyOfBob = Buffer.from(alice.sparkIdentityPubkey, 'hex')

  const aliceBalSnapshot = aliceFunded
  const bobBalSnapshot = bobFunded
  const t0 = Date.now()

  // Use ParametersOf… casts because the lib types declare TreeNode[]
  // (an SDK internal); we pass through the raw leaf shape verbatim.
  const sellerPromise = runSellerFlow(alice.spark, {
    assetLeaves: [carrier] as unknown as Parameters<typeof runSellerFlow>[1]['assetLeaves'],
    counterpartyPubkey: counterpartyOfAlice,
    expectedSatsFromBuyer: PRICE_SATS,
    expiryTime: sellerExpiry,
    preimage,
    pollIntervalMs: 2_000,
    onState: (s) =>
      console.log(`  [seller ${ms(t0)}] ${s.phase}: ${s.message}`),
  })

  // Bob picks vanilla leaves summing to ≥ priceSats.
  const bobLeaves = await bob.spark.getLeaves(true)
  const sorted = [...bobLeaves].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
  let acc = 0
  const bobSatsLeaves: typeof bobLeaves = []
  for (const l of sorted) {
    if (acc >= PRICE_SATS) break
    bobSatsLeaves.push(l)
    acc += Number(l.value ?? 0)
  }
  if (acc < PRICE_SATS) {
    return {
      passed: false,
      steps: [...steps, { name: 'bob can plan sats lock', ok: false, detail: `accumulated ${acc} < ${PRICE_SATS}` }],
      summary: 'bob has no leaf-set summing to priceSats',
    }
  }
  steps.push({
    name: 'bob sats-lock plan',
    ok: true,
    detail: `${bobSatsLeaves.length} leaves summing to ${acc} sats (target ${PRICE_SATS})`,
  })

  const buyerPromise = runBuyerFlow(bob.spark, {
    satsLeaves: bobSatsLeaves as unknown as Parameters<typeof runBuyerFlow>[1]['satsLeaves'],
    counterpartyPubkey: counterpartyOfBob,
    paymentHash,
    expiryTime: buyerExpiry,
    pollIntervalMs: 2_000,
    onState: (s) =>
      console.log(`  [buyer  ${ms(t0)}] ${s.phase}: ${s.message}`),
  })

  const [sellerResult, buyerResult] = await Promise.all([sellerPromise, buyerPromise])

  steps.push({
    name: 'seller flow outcome',
    ok: sellerResult.outcome === 'completed',
    detail: `outcome=${sellerResult.outcome}  cause=${sellerResult.state.cause ?? '—'}`,
  })
  steps.push({
    name: 'buyer flow outcome',
    ok: buyerResult.outcome === 'completed',
    detail: `outcome=${buyerResult.outcome}  claimedLeafId=${buyerResult.claimedLeafId?.slice(0, 18) ?? '—'}…`,
  })

  if (sellerResult.outcome !== 'completed' || buyerResult.outcome !== 'completed') {
    return { passed: false, steps, summary: 'one or both flows failed — atomicity primitive unhealthy' }
  }

  // 6. Post-conditions.
  const aliceFinal = await alice.getAvailableBalance()
  const bobFinal = await bob.getAvailableBalance()
  const aliceDelta = aliceFinal - aliceBalSnapshot
  const bobDelta = bobFinal - bobBalSnapshot

  // Alice expected delta: +priceSats - carrier_value (she gave up the
  // carrier leaf). Bob expected delta: -priceSats + carrier_value.
  const carrierVal = BigInt(Number(carrier.value ?? 0))
  const expectedAlice = BigInt(PRICE_SATS) - carrierVal
  const expectedBob = -BigInt(PRICE_SATS) + carrierVal
  steps.push({
    name: 'alice balance delta',
    ok: aliceDelta === expectedAlice,
    detail: `actual=${aliceDelta}  expected=${expectedAlice}`,
  })
  steps.push({
    name: 'bob balance delta',
    ok: bobDelta === expectedBob,
    detail: `actual=${bobDelta}  expected=${expectedBob}`,
  })
  steps.push({
    name: 'bob holds the alice-locked carrier leaf id',
    ok: buyerResult.claimedLeafId === String(carrier.id),
    detail: `claimed=${buyerResult.claimedLeafId?.slice(0, 18) ?? '—'}  carrier=${String(carrier.id).slice(0, 18)}`,
  })

  await alice.spark.cleanupConnections().catch(() => undefined)
  await bob.spark.cleanupConnections().catch(() => undefined)

  const allOk = steps.every((s) => s.ok)
  return {
    passed: allOk,
    steps,
    summary: allOk
      ? 'HTLC primitive moves value atomically and bob receives the seller-locked leaf'
      : 'HTLC primitive broken — see failing steps',
  }
}

function ms(t0: number): string {
  const dt = Date.now() - t0
  return `${(dt / 1000).toFixed(1)}s`.padStart(5, ' ')
}
