// scenario:htlc-probe-sync — diagnostic for the htlc-only timeout.
//
// Hypothesis (per SDK type defs): the SDK's auto-claim relies on a
// gRPC `subscribe_to_events` stream. If the stream isn't fully
// connected, incoming-transfer "ready to claim" signals are missed and
// the claim never executes locally. Symptom: providePreimage succeeds
// at the coordinator (preimage broadcast publicly) but neither wallet
// crediats the transferred leaf to itself.
//
// What this probe does differently from htlc-only:
//   1. Attaches event listeners on both wallets BEFORE the swap.
//      Logs StreamConnected / Disconnected / Reconnecting and
//      TransferClaimed (the official "claim landed" signal).
//   2. Calls `experimental_syncWallet()` periodically on each wallet
//      between providePreimage and the leaf-arrival check. If the
//      auto-claim is "slow but works when poked", a manual sync
//      forces it. If it's truly stuck, sync does nothing.
//   3. Bypasses the rgb-spark/lib runSellerFlow/runBuyerFlow — too
//      coarse for the probe — and drives the four primitives
//      directly (lock, query, reveal/claim, post-claim sync).
//
// Outcome cases:
//   - balance moves WITHOUT any manual sync         → auto-claim works (SDK is just slow)
//   - balance moves AFTER experimental_syncWallet  → fix = call sync in claim verify loop
//   - balance never moves but TransferClaimed fires → SDK claim ≠ getLeaves cache
//   - balance never moves and no events            → gRPC stream not connecting in Node

import { deriveSubSeedHex } from '../lib/derive-seed.ts'
import { createTestWallet, type TestWallet } from '../lib/test-wallet.ts'
import {
  lockUnderHash,
  queryPendingHtlcs,
  revealAndClaim,
  queryRevealedPreimage,
  newPreimagePair,
} from '@rgb-spark/lib/htlcSwap'
import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

const PRICE_SATS = 150
const PER_WALLET_FUND = 300n
const BUYER_EXPIRY_MS = 5 * 60_000
const SELLER_EXPIRY_MS = 15 * 60_000
const PROBE_WINDOW_MS = 240_000 // 4 min
const SYNC_INTERVAL_MS = 5_000

interface SparkTransferAPI {
  transfer: (opts: { receiverSparkAddress: string; amountSats: number }) => Promise<{ id: string }>
}

interface SparkSyncAPI {
  experimental_syncWallet?: () => Promise<void>
  on?: (event: string, cb: (...args: unknown[]) => void) => unknown
  getLeaves: (b?: boolean) => Promise<Array<{ id: string; value: number }>>
}

function attachLogging(label: string, w: TestWallet): { observed: { event: string; at: number }[] } {
  const observed: { event: string; at: number }[] = []
  const ee = w.spark as unknown as SparkSyncAPI
  if (typeof ee.on === 'function') {
    const t0 = Date.now()
    const events = [
      'stream:connected',
      'stream:disconnected',
      'stream:reconnecting',
      'transfer:claimed',
      'balance:update',
      'deposit:confirmed',
    ]
    for (const e of events) {
      try {
        ee.on(e, (...args: unknown[]) => {
          const dt = Date.now() - t0
          observed.push({ event: e, at: dt })
          console.log(`  [${label}@${(dt / 1000).toFixed(1)}s] ${e}`, JSON.stringify(args).slice(0, 120))
        })
      } catch {
        // SDK rejects some event names; ignore.
      }
    }
  }
  return { observed }
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

export default async function htlcProbeSync(ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: ScenarioResult['steps'] = []

  // Wallets — reuse smoke:alice/bob so we benefit from any existing
  // funding. Different seeds from htlc-only avoids polluting that
  // scenario's state if both run back-to-back.
  const alice = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'probe:alice'),
    network: ctx.network,
    label: 'alice',
  })
  const bob = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'probe:bob'),
    network: ctx.network,
    label: 'bob',
  })

  const aliceEvents = attachLogging('alice', alice)
  const bobEvents = attachLogging('bob', bob)

  steps.push({ name: 'wallets created + event listeners attached', ok: true })

  // Top-up
  if ((await alice.getAvailableBalance()) < PER_WALLET_FUND) {
    await fund(ctx.funding, alice, Number(PER_WALLET_FUND))
  }
  if ((await bob.getAvailableBalance()) < PER_WALLET_FUND) {
    await fund(ctx.funding, bob, Number(PER_WALLET_FUND))
  }
  const aliceBefore = await waitFor(alice, PER_WALLET_FUND)
  const bobBefore = await waitFor(bob, PER_WALLET_FUND)
  steps.push({
    name: 'top-up complete',
    ok: aliceBefore >= PER_WALLET_FUND && bobBefore >= PER_WALLET_FUND,
    detail: `alice=${aliceBefore}  bob=${bobBefore}`,
  })

  const { preimage, paymentHash } = newPreimagePair()

  const aliceLeaves = await alice.spark.getLeaves(true)
  const carrier = [...aliceLeaves].sort((a, b) => Number(a.value ?? 0) - Number(b.value ?? 0))[0]
  if (!carrier) return { passed: false, steps, summary: 'alice has no leaf to lock' }

  // Locks (sequential, both ours so no race).
  const sellerExpiry = new Date(Date.now() + SELLER_EXPIRY_MS)
  const buyerExpiry = new Date(Date.now() + BUYER_EXPIRY_MS)

  console.log(`  ▶ alice locks ${carrier.value}-sat carrier to bob`)
  await lockUnderHash(alice.spark, {
    leaves: [carrier] as unknown as Parameters<typeof lockUnderHash>[1]['leaves'],
    recipientIdentityPubkey: Buffer.from(bob.sparkIdentityPubkey, 'hex'),
    paymentHash,
    expiryTime: sellerExpiry,
  })

  const bobLeaves = await bob.spark.getLeaves(true)
  const sorted = [...bobLeaves].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
  let acc = 0
  const bobSatsLeaves: typeof bobLeaves = []
  for (const l of sorted) {
    if (acc >= PRICE_SATS) break
    bobSatsLeaves.push(l)
    acc += Number(l.value ?? 0)
  }
  console.log(`  ▶ bob locks ${acc} sats (${bobSatsLeaves.length} leaves) to alice`)
  await lockUnderHash(bob.spark, {
    leaves: bobSatsLeaves as unknown as Parameters<typeof lockUnderHash>[1]['leaves'],
    recipientIdentityPubkey: Buffer.from(alice.sparkIdentityPubkey, 'hex'),
    paymentHash,
    expiryTime: buyerExpiry,
  })

  // Wait for both locks to be visible at the coordinator before reveal
  // (matches what runSellerFlow does internally).
  const aliceSeesBobLock = await waitForHtlc(alice.spark, paymentHash, 'receiver', 60_000)
  steps.push({
    name: 'alice sees bob lock',
    ok: aliceSeesBobLock,
    detail: aliceSeesBobLock ? '' : 'bob lock not visible to alice within 60s',
  })

  console.log('  ▶ alice reveals preimage')
  await revealAndClaim(alice.spark, preimage)

  // Probe loop: every SYNC_INTERVAL_MS, call experimental_syncWallet
  // on both sides and re-check balances + leaves. Record what happens.
  const aliceSparkSync = alice.spark as unknown as SparkSyncAPI
  const bobSparkSync = bob.spark as unknown as SparkSyncAPI
  const aliceLeavesBefore = new Set(aliceLeaves.map((l) => String(l.id)))
  const bobLeavesBefore = new Set(bobLeaves.map((l) => String(l.id)))

  const deadline = Date.now() + PROBE_WINDOW_MS
  let aliceClaimed = false
  let bobClaimed = false
  let firstAliceClaimedAt: number | null = null
  let firstBobClaimedAt: number | null = null
  let firstAliceSyncedClaimAt: number | null = null
  let firstBobSyncedClaimAt: number | null = null
  let aliceClaimViaSync = false
  let bobClaimViaSync = false

  const t0 = Date.now()
  while (Date.now() < deadline && (!aliceClaimed || !bobClaimed)) {
    // 1. raw check (no sync) — does the SDK auto-claim by itself?
    const aliceBal = await alice.getAvailableBalance()
    const aliceL = await alice.spark.getLeaves(true)
    const bobL = await bob.spark.getLeaves(true)
    if (!aliceClaimed && aliceBal - aliceBefore >= BigInt(PRICE_SATS) - BigInt(carrier.value ?? 0)) {
      aliceClaimed = true
      firstAliceClaimedAt = Date.now() - t0
      console.log(`  ✓ alice balance delta visible at ${(firstAliceClaimedAt / 1000).toFixed(1)}s`)
    }
    if (!bobClaimed) {
      const newLeaves = aliceL // wait this is wrong; bob's new leaf shows in bobL
      void newLeaves
      const bobNewLeaves = bobL.filter((l) => !bobLeavesBefore.has(String(l.id)))
      if (bobNewLeaves.length > 0) {
        bobClaimed = true
        firstBobClaimedAt = Date.now() - t0
        console.log(`  ✓ bob new leaf arrived at ${(firstBobClaimedAt / 1000).toFixed(1)}s id=${String(bobNewLeaves[0].id).slice(0, 18)}…`)
      }
      // also surface alice's incoming leaf for symmetry
      const aliceNewLeaves = aliceL.filter((l) => !aliceLeavesBefore.has(String(l.id)))
      if (aliceNewLeaves.length > 0) {
        console.log(`  · alice has ${aliceNewLeaves.length} new leaf(s)`)
      }
    }
    if (aliceClaimed && bobClaimed) break

    // 2. forced sync — if the SDK is just slow without an external poke
    if (typeof aliceSparkSync.experimental_syncWallet === 'function') {
      await aliceSparkSync.experimental_syncWallet().catch(() => undefined)
    }
    if (typeof bobSparkSync.experimental_syncWallet === 'function') {
      await bobSparkSync.experimental_syncWallet().catch(() => undefined)
    }

    // 3. re-check after sync
    const aliceBal2 = await alice.getAvailableBalance()
    const bobL2 = await bob.spark.getLeaves(true)
    if (!aliceClaimed && aliceBal2 - aliceBefore >= BigInt(PRICE_SATS) - BigInt(carrier.value ?? 0)) {
      aliceClaimed = true
      aliceClaimViaSync = true
      firstAliceSyncedClaimAt = Date.now() - t0
      console.log(`  ✓ alice claim ONLY AFTER sync at ${(firstAliceSyncedClaimAt / 1000).toFixed(1)}s`)
    }
    if (!bobClaimed) {
      const bobNew2 = bobL2.filter((l) => !bobLeavesBefore.has(String(l.id)))
      if (bobNew2.length > 0) {
        bobClaimed = true
        bobClaimViaSync = true
        firstBobSyncedClaimAt = Date.now() - t0
        console.log(`  ✓ bob claim ONLY AFTER sync at ${(firstBobSyncedClaimAt / 1000).toFixed(1)}s`)
      }
    }

    await new Promise((r) => setTimeout(r, SYNC_INTERVAL_MS))
  }

  // Encourage bob to claim too if he hasn't yet (he needs to call
  // revealAndClaim with the now-public preimage).
  if (!bobClaimed) {
    const revealed = await queryRevealedPreimage(
      bob.spark,
      paymentHash,
      Buffer.from(alice.sparkIdentityPubkey, 'hex'),
    )
    if (revealed) {
      console.log('  ▶ bob pulls revealed preimage and claims')
      await revealAndClaim(bob.spark, revealed).catch((e) => console.log('   revealAndClaim:', e instanceof Error ? e.message : String(e)))
    }
  }

  steps.push({
    name: 'alice claim observed',
    ok: aliceClaimed,
    detail: aliceClaimed
      ? `at ${((firstAliceClaimedAt ?? firstAliceSyncedClaimAt ?? 0) / 1000).toFixed(1)}s${aliceClaimViaSync ? ' (after manual sync)' : ' (auto)'}`
      : 'never within probe window',
  })
  steps.push({
    name: 'bob claim observed',
    ok: bobClaimed,
    detail: bobClaimed
      ? `at ${((firstBobClaimedAt ?? firstBobSyncedClaimAt ?? 0) / 1000).toFixed(1)}s${bobClaimViaSync ? ' (after manual sync)' : ' (auto)'}`
      : 'never within probe window',
  })
  steps.push({
    name: 'stream events received',
    ok: true,
    detail: `alice=${aliceEvents.observed.map((e) => e.event).join(',') || '(none)'}  bob=${bobEvents.observed.map((e) => e.event).join(',') || '(none)'}`,
  })

  await alice.spark.cleanupConnections().catch(() => undefined)
  await bob.spark.cleanupConnections().catch(() => undefined)

  const summary = aliceClaimed && bobClaimed
    ? (aliceClaimViaSync || bobClaimViaSync
        ? 'CLAIMS WORK with manual experimental_syncWallet — fix the lib to call it'
        : 'auto-claim works without manual intervention; SDK was just slow')
    : 'claims never landed even with manual sync — deeper SDK issue (gRPC stream?)'

  return {
    passed: aliceClaimed && bobClaimed,
    steps,
    summary,
  }
}

async function waitForHtlc(
  spark: unknown,
  paymentHash: Uint8Array,
  role: 'receiver' | 'sender',
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await queryPendingHtlcs(spark, {
        role,
        paymentHashes: [paymentHash],
        status: 'waiting',
        limit: 5,
      })
      if (r.length > 0) return true
    } catch {
      // soft retry
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return false
}
