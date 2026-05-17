## `swapNodesForPreimage` with empty `invoiceString`: claim fails "Signature verification failed"

**SDK**: `@buildonspark/spark-sdk@0.7.17`
**Runtime**: Node 22.22.2 (also observed in Brave/Safari iOS via app frontend)
**Network**: MAINNET

### Summary

Calling `swapNodesForPreimage` with `invoiceString: ""` (= pure Spark-native HTLC, no Lightning bridge) succeeds at the lock step on both sides. `providePreimage` succeeds and returns a `Transfer` from the coordinator. **But neither auto-claim (via the `subscribe_to_events` gRPC stream) nor manual claim (calling `wallet.transferService.claimTransfer(transfer)`) hydrates the locked leaves into the receiver's wallet.** Manual claim fails with:

```
[TransferService:…] Failed to claim transfer after all retries.
Transfer ID: 019e375e-2e32-748b-bef3-09cc1bf3fce6.
Error: Signature verification failed
```

The auto-claim path silently times out (the event fires but balance / getLeaves never reflect the new leaf). The manual path surfaces the underlying SE-side rejection.

### Steps to reproduce

Two `SparkWallet` instances on mainnet (alice + bob), each pre-funded with ≥ 300 sats.

```ts
import { newPreimagePair } from '@buildonspark/spark-sdk' // or your equivalent helper
const { preimage, paymentHash } = newPreimagePair()

// 1. Alice locks a small carrier leaf to Bob under H.
await alice.lightningService.swapNodesForPreimage({
  leaves: [aliceCarrierLeaf],
  receiverIdentityPubkey: bobIdentityPubkey,
  paymentHash,
  invoiceString: '',                      // ← the niche mode
  isInboundPayment: false,
  feeSats: 0,
  expiryTime: new Date(Date.now() + 15 * 60_000),
})

// 2. Bob locks his sat-leaves to Alice under H (T_buyer < T_seller margin).
await bob.lightningService.swapNodesForPreimage({
  leaves: bobSatsLeaves,
  receiverIdentityPubkey: aliceIdentityPubkey,
  paymentHash,
  invoiceString: '',
  isInboundPayment: false,
  feeSats: 0,
  expiryTime: new Date(Date.now() + 5 * 60_000),
})

// 3. Alice reveals; capture the returned Transfer.
const aliceClaimTransfer = await alice.lightningService.providePreimage(preimage)

// 4. Try to claim manually with the returned Transfer.
const claimedLeaves = await alice.transferService.claimTransfer(aliceClaimTransfer)
// ↑ throws SparkError: Failed to claim transfer: Signature verification failed
```

The same happens on Bob's side after he calls `providePreimage(revealed)` to claim Alice's locked carrier.

### Expected

`claimTransfer(aliceClaimTransfer)` succeeds and `claimedLeaves` contains the bob-locked sat leaves now owned by alice. `alice.getLeaves(true)` reflects them; `alice.getBalance().satsBalance.available` increases by the locked total.

### Actual

`Signature verification failed` from the Spark Operator. No leaves hydrate. Atomicity holds at the coordinator (both legs eventually expire via `TRANSFER_STATUS_RETURNED` if not claimed) but the trade can never complete.

### What we ruled out

- **Not a signer issue**: identical failure with `DefaultSparkSigner` and with a custom signer (`RgbAwareSparkSigner`).
- **Not a BigInt-serialization issue**: we patched `BigInt.prototype.toJSON = () => this.toString()` to fix the SDK's internal "Do not know how to serialize a BigInt" event-handler log. The error persists after the patch.
- **Not a stream / timing issue**: manual `transferService.claimTransfer(transfer)` reproduces the same failure synchronously, bypassing the gRPC stream path entirely.
- **Not stale timelocks**: `wallet.optimizeLeaves()` consumed to completion on both wallets before the lock step.

### What works (sanity baseline)

- Plain Spark→Spark `wallet.transfer({ receiverSparkAddress, amountSats })` claims correctly on the receiver side.
- HTLC `swapNodesForPreimage` lock / `providePreimage` reveal / status transitions (WAITING → SHARED → RETURNED on expiry) all behave as expected.

### Reproducer repo

Full minimal Node harness with the failing scenario + sibling diagnostics (auto-claim probe, default-signer ablation): https://github.com/LastDegenBtc/rgb-spark/tree/main/e2e-tests

Run:
```sh
cd e2e-tests
npm install
npm run setup     # prints a Spark address to fund (~500 sats enough)
npm run scenario:htlc-manual
```

### Why this matters

We're building an RGB-on-Spark atomic swap layer where the trade primitive REQUIRES the seller's specific Spark leaf to land in the buyer's wallet (the leaf carries an RGB binding via Spark-UTK keytweak). Lightning-bridged HTLC (with a real `invoiceString`) doesn't satisfy this because it routes equivalent sats via LSPs rather than transferring the specific leaf.

Empty-invoice HTLC was probed as the closest fit but evidently isn't fully wired for settlement. A fix here unlocks an entire trustless asset-trading category on Spark.

Thanks!
