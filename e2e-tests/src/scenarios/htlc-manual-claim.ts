// scenario:htlc-manual-claim — calls providePreimage directly,
// keeps the returned Transfer, and feeds it into
// `wallet.transferService.claimTransfer(transfer)` manually.
//
// Hypothesis: the SDK's auto-claim path relies on a `subscribe_to_events`
// gRPC stream that doesn't reliably deliver receiverTransfer events for
// empty-invoice HTLC swaps in Node. The fallback is to call claimTransfer
// explicitly with the Transfer object providePreimage already returned.
//
// If THIS works:
//   - The fix is a 10-line patch in rgb-spark/lib/htlcSwap's revealAndClaim.
//   - rgb-spark architecture stays intact (leaf-bound atomic swap still works).
//   - No SDK upstream change needed.
//
// If this doesn't work:
//   - The SDK truly doesn't support empty-invoice HTLC settlement.
//   - We've definitively shown the rgb-spark Phase 1C foundation has a hole.

import { deriveSubSeedHex } from '../lib/derive-seed.ts'
import { createTestWallet, type TestWallet } from '../lib/test-wallet.ts'
import {
  lockUnderHash,
  queryPendingHtlcs,
  queryRevealedPreimage,
  newPreimagePair,
} from '@rgb-spark/lib/htlcSwap'
import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

const PRICE_SATS = 150
const PER_WALLET_FUND = 300n
const BUYER_EXPIRY_MS = 5 * 60_000
const SELLER_EXPIRY_MS = 15 * 60_000
const LEAF_WAIT_MS = 60_000

interface SparkTransferAPI {
  transfer: (opts: { receiverSparkAddress: string; amountSats: number }) => Promise<{ id: string }>
}

// What we expect to find under wallet.* once the SDK is initialized.
// Both surfaces below are technically private/internal but exposed at
// runtime — we cast through `unknown` to keep TS quiet, same posture
// as rgb-spark/lib/htlcSwap's `asInternals`.
interface WalletInternals {
  lightningService: {
    providePreimage: (preimage: Uint8Array) => Promise<unknown>
  }
  transferService: {
    claimTransfer: (transfer: unknown) => Promise<Array<{ id: string; value?: number | bigint }>>
  }
  getLeaves: (b?: boolean) => Promise<Array<{ id: string; value?: number | bigint; status?: string }>>
  optimizeLeaves: (
    multiplicity?: number,
  ) => AsyncGenerator<{ step: number; total: number }, void, void>
}

/** Walk the SDK's optimizeLeaves generator to completion. Refreshes
 *  leaves with depleted timelocks (which would otherwise crash
 *  swapNodesForPreimage with "timelock interval is less than or equal
 *  to 0"). Cheap when already optimal; ~1 RPC per swap when not. */
async function refreshLeaves(label: string, w: TestWallet): Promise<void> {
  const wi = w.spark as unknown as WalletInternals
  if (typeof wi.optimizeLeaves !== 'function') return
  try {
    for await (const tick of wi.optimizeLeaves()) {
      console.log(`  [optimizeLeaves ${label}] step ${tick.step}/${tick.total}`)
    }
  } catch (e) {
    console.log(`  [optimizeLeaves ${label}] threw: ${e instanceof Error ? e.message : String(e)}`)
  }
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

export default async function htlcManualClaim(ctx: ScenarioContext): Promise<ScenarioResult> {
  const steps: ScenarioResult['steps'] = []

  // Fresh wallet seeds for this experiment so we don't inherit state
  // from any previous scenario (open HTLCs, locked leaves, …).
  const alice = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'manual-claim:alice'),
    network: ctx.network,
    label: 'alice',
    signerKind: 'default',
  })
  const bob = await createTestWallet({
    seedHex: deriveSubSeedHex(ctx.funding.nostrPrivkeyHex, 'manual-claim:bob'),
    network: ctx.network,
    label: 'bob',
    signerKind: 'default',
  })
  steps.push({ name: 'fresh wallets with DefaultSparkSigner', ok: true })

  // Top-up
  if ((await alice.getAvailableBalance()) < PER_WALLET_FUND) {
    await fund(ctx.funding, alice, Number(PER_WALLET_FUND))
  }
  if ((await bob.getAvailableBalance()) < PER_WALLET_FUND) {
    await fund(ctx.funding, bob, Number(PER_WALLET_FUND))
  }
  const aliceBalBefore = await waitFor(alice, PER_WALLET_FUND)
  const bobBalBefore = await waitFor(bob, PER_WALLET_FUND)
  steps.push({
    name: `fund alice + bob to ≥ ${PER_WALLET_FUND}`,
    ok: aliceBalBefore >= PER_WALLET_FUND && bobBalBefore >= PER_WALLET_FUND,
    detail: `alice=${aliceBalBefore}  bob=${bobBalBefore}`,
  })

  // Refresh leaves before locking — depleted timelocks (inherited from
  // funding wallet via top-up transfers) would crash swapNodesForPreimage.
  await refreshLeaves('alice', alice)
  await refreshLeaves('bob', bob)

  const aliceLeavesBefore = await alice.spark.getLeaves(true)
  const bobLeavesBefore = await bob.spark.getLeaves(true)
  const aliceIdsBefore = new Set(aliceLeavesBefore.map((l) => String(l.id)))
  const bobIdsBefore = new Set(bobLeavesBefore.map((l) => String(l.id)))

  const { preimage, paymentHash } = newPreimagePair()
  const carrier = [...aliceLeavesBefore].sort((a, b) => Number(a.value ?? 0) - Number(b.value ?? 0))[0]
  if (!carrier) return { passed: false, steps, summary: 'alice has no leaves' }

  // Locks
  console.log(`  ▶ alice locks ${carrier.value}-sat carrier to bob`)
  await lockUnderHash(alice.spark, {
    leaves: [carrier] as unknown as Parameters<typeof lockUnderHash>[1]['leaves'],
    recipientIdentityPubkey: Buffer.from(bob.sparkIdentityPubkey, 'hex'),
    paymentHash,
    expiryTime: new Date(Date.now() + SELLER_EXPIRY_MS),
  })

  const sorted = [...bobLeavesBefore].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0))
  let acc = 0
  const bobSatsLeaves: typeof bobLeavesBefore = []
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
    expiryTime: new Date(Date.now() + BUYER_EXPIRY_MS),
  })

  // Confirm both visible at coordinator
  const aliceSeesBob = await waitForHtlc(alice.spark, paymentHash, 'receiver', 60_000)
  steps.push({
    name: 'alice sees bob lock at coordinator',
    ok: aliceSeesBob,
    detail: aliceSeesBob ? '' : 'bob lock not visible to alice within 60s',
  })
  if (!aliceSeesBob) return { passed: false, steps, summary: 'lock visibility broken' }

  // === The key experiment: providePreimage + manual claimTransfer ===

  const aliceInternals = alice.spark as unknown as WalletInternals
  const bobInternals = bob.spark as unknown as WalletInternals

  console.log('  ▶ alice providePreimage (capture returned Transfer)')
  const aliceTransfer = await aliceInternals.lightningService.providePreimage(preimage)
  console.log(`    transfer returned: ${JSON.stringify(aliceTransfer).slice(0, 200)}…`)

  console.log('  ▶ alice transferService.claimTransfer(transfer) — MANUAL')
  let aliceClaimedLeaves: Array<{ id: string; value?: number | bigint }> = []
  try {
    aliceClaimedLeaves = await aliceInternals.transferService.claimTransfer(aliceTransfer)
    console.log(`    claimed ${aliceClaimedLeaves.length} leaves`)
  } catch (e) {
    steps.push({
      name: 'alice manual claimTransfer',
      ok: false,
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    })
    return { passed: false, steps, summary: 'alice manual claim throws — different bug entirely' }
  }
  steps.push({
    name: 'alice manual claimTransfer returned leaves',
    ok: aliceClaimedLeaves.length > 0,
    detail: `${aliceClaimedLeaves.length} leaves, ids=[${aliceClaimedLeaves.map((l) => String(l.id).slice(0, 14)).join(', ')}]`,
  })

  // Bob polls for the revealed preimage, then does the same dance.
  console.log('  ▶ bob queryRevealedPreimage')
  const revealed = await queryRevealedPreimage(
    bob.spark,
    paymentHash,
    Buffer.from(alice.sparkIdentityPubkey, 'hex'),
  )
  if (!revealed) {
    steps.push({ name: 'bob sees revealed preimage', ok: false })
    return { passed: false, steps, summary: 'preimage not visible to bob' }
  }
  steps.push({ name: 'bob sees revealed preimage', ok: true })

  console.log('  ▶ bob providePreimage')
  const bobTransfer = await bobInternals.lightningService.providePreimage(revealed)
  console.log(`    transfer returned: ${JSON.stringify(bobTransfer).slice(0, 200)}…`)

  console.log('  ▶ bob transferService.claimTransfer(transfer) — MANUAL')
  let bobClaimedLeaves: Array<{ id: string; value?: number | bigint }> = []
  try {
    bobClaimedLeaves = await bobInternals.transferService.claimTransfer(bobTransfer)
    console.log(`    claimed ${bobClaimedLeaves.length} leaves`)
  } catch (e) {
    steps.push({
      name: 'bob manual claimTransfer',
      ok: false,
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    })
    return { passed: false, steps, summary: 'bob manual claim throws — different bug entirely' }
  }
  steps.push({
    name: 'bob manual claimTransfer returned leaves',
    ok: bobClaimedLeaves.length > 0,
    detail: `${bobClaimedLeaves.length} leaves, ids=[${bobClaimedLeaves.map((l) => String(l.id).slice(0, 14)).join(', ')}]`,
  })

  // Did the claimed leaves arrive in getLeaves? Poll a bit since the
  // SDK's local cache may need a tick.
  console.log('  ▶ polling getLeaves for new entries on both wallets')
  const deadline = Date.now() + LEAF_WAIT_MS
  let aliceNew: Array<{ id: string }> = []
  let bobNew: Array<{ id: string }> = []
  while (Date.now() < deadline && (aliceNew.length === 0 || bobNew.length === 0)) {
    const aliceL = await alice.spark.getLeaves(true)
    const bobL = await bob.spark.getLeaves(true)
    aliceNew = aliceL.filter((l) => !aliceIdsBefore.has(String(l.id)))
    bobNew = bobL.filter((l) => !bobIdsBefore.has(String(l.id)))
    if (aliceNew.length > 0 && bobNew.length > 0) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  steps.push({
    name: 'alice has new leaf in getLeaves',
    ok: aliceNew.length > 0,
    detail: aliceNew.length > 0 ? `+${aliceNew.length} leaves` : 'none after manual claim',
  })
  steps.push({
    name: 'bob has new leaf in getLeaves',
    ok: bobNew.length > 0,
    detail: bobNew.length > 0 ? `+${bobNew.length} leaves` : 'none after manual claim',
  })

  // Balance deltas
  const aliceFinal = await alice.getAvailableBalance()
  const bobFinal = await bob.getAvailableBalance()
  steps.push({
    name: 'alice balance delta',
    ok: aliceFinal !== aliceBalBefore,
    detail: `before=${aliceBalBefore}  after=${aliceFinal}  delta=${aliceFinal - aliceBalBefore}`,
  })
  steps.push({
    name: 'bob balance delta',
    ok: bobFinal !== bobBalBefore,
    detail: `before=${bobBalBefore}  after=${bobFinal}  delta=${bobFinal - bobBalBefore}`,
  })

  await alice.spark.cleanupConnections().catch(() => undefined)
  await bob.spark.cleanupConnections().catch(() => undefined)

  const allOk = steps.every((s) => s.ok)
  return {
    passed: allOk,
    steps,
    summary: allOk
      ? 'MANUAL claim works — patch rgb-spark/lib/htlcSwap and rgb-spark is back on track'
      : 'manual claim does NOT hydrate leaves either — SDK has a real gap in empty-invoice HTLC settlement; file upstream or pivot architecture',
  }
}
