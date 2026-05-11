# 05 · Spark SDK leaf-data surface (step 9c recon)

> **Status**: scoping notes for step 9c — binding `SparkUtkProof` to real
> Spark leaves. Sources cited inline. Initial pass 2026-05-11 from
> `@buildonspark/spark-sdk@0.7.17` shipped with the frontend.

## Correction · 2026-05-11 (after first MAINNET run)

The original TL;DR below claimed that for `msg = 0`, the Spark-UTK relation
collapses to `verifyingPublicKey == u_base + operator`, and that calling
`deriveVerifyingKey(u_base, ZERO_MSG, operator)` is the right receiver-side
check.

**Both claims are wrong.** A first run against a real MAINNET leaf produced
a mismatch:

```
leaf.ownerSigningPublicKey   = 023e3c385fa203ea407db3b6d1bb0a9345a2f42241c49df189a7a23f72d9e0ba2b
leaf.signingKeyshare.pk      = 03c8f05195813ad6f0a8b3c41fa1fb6d0b34880c3e9121c80a2d02a6e2b64d9110
leaf.verifyingPublicKey      = 0372f480dfdb70fd17884e7365ee5874340012dfadf967f6ca3317fc383026a656
deriveVerifyingKey(uB, 0, op)= 03c036880803d326804f6e0f797cccbbfea53ff58c8c5c9e9cff2f734c2016bf1c  ← MISMATCH
```

Reason: `deriveVerifyingKey` applies the SparkUtk tweak unconditionally
(`t = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)`). Even with `msg = 0`,
`t` is the non-zero output of a tagged hash, so the SparkUtk-tweaked
verifying key ≠ the vanilla Spark sum. The "collapse" only happens if the
tweak is *skipped*, which is not what the Rust primitive does.

### What Spark actually uses

The SDK's own per-leaf check (`spark-wallet-…js:14868`) is:

```js
verifyKey(pubkey1, pubkey2, verifyingKey) {
  return equalBytes(addPublicKeys(pubkey1, pubkey2), verifyingKey)
}
```

with `addPublicKeys` being plain secp256k1 point addition (no tweak):

```js
function addPublicKeys(a, b) {
  return secp256k1.Point.fromHex(a).add(secp256k1.Point.fromHex(b)).toBytes(true)
}
```

Confirmed against the MAINNET leaf above:
`addPublicKeys(ownerSigningPublicKey, signingKeyshare.publicKey)
== verifyingPublicKey`. So **Spark vanilla leaves use straight point
addition**, not any tagged-hash tweak.

### Consequence for chunk-α

The receiver-side check is one line, using a public SDK export:

```ts
import { addPublicKeys } from '@buildonspark/spark-sdk'

const ok = bytesToHex(addPublicKeys(uBaseBytes, operatorBytes))
        === leaf.verifyingPublicKey
```

No WASM rebuild, no fork, no SparkUtk primitive involved. Chunk-α proves
*"the proof refers to a real Spark leaf the SE knows"* — which is a useful
authenticity check, but it is **not** a Spark-UTK binding demo. The leaf's
verifying key carries no RGB commitment because the SDK never injected a
non-zero `msg` at leaf creation. Spark-UTK binding still requires injecting
`U_tweaked` into the SE's keygen path → chunk-α-bis (SDK fork /
monkey-patch).

## TL;DR (original — superseded; left for historical context)

Everything we need for an *airtight cryptographic demo* is already exposed
by the SDK. `TreeNode` (the proto-level leaf object) carries:

- `ownerSigningPublicKey` — per-leaf, 33-byte compressed → this is our **`u_base`** candidate
- `signingKeyshare.publicKey` — aggregated FROST operator pubkey → our **`operator`**
- `verifyingPublicKey` — the leaf's full verifying key

For a vanilla (non-RGB) Spark transfer, `msg = 0`, so the Spark-UTK relation
collapses to:

```
verifyingPublicKey == ownerSigningPublicKey + signingKeyshare.publicKey
                  ^^^                       ^^^^^^^^^^^^^^^^^^^^^^^^^
                  u_base                    operator
```

Receiver can **verify the proof against the real leaf** by calling
`deriveVerifyingKey(u_base, ZERO_MSG, operator)` and comparing to the leaf's
own `verifyingPublicKey`. If they match → the proof refers to a real Spark
leaf that exists on the SE.

This makes the chunk-α demo mathematically meaningful, not just "we read a
leaf's hex." The only thing missing from a *full* Spark-UTK demo is the
ability to set a non-zero `msg` (= an RGB Merkle commitment) at leaf
creation — that requires injecting `U_tweaked` instead of `U_base` when the
wallet asks the SE to co-sign a new leaf. Stock SDK doesn't expose that hook
(step 9c-bis: SDK fork or monkey-patch).

## Key SDK call paths

### Read existing leaves
```ts
wallet.getLeaves(isBalanceCheck?: boolean): Promise<TreeNode[]>
```
`types-CPXB2AOW.d.ts:2342` — returns raw `TreeNode[]` with all per-leaf
fields including `ownerSigningPublicKey`. Use this for the read-side of the
demo (no transfer required, just inspect what the wallet already has).

### After a transfer
```ts
wallet.transfer({ amountSats, receiverSparkAddress }): Promise<WalletTransfer>
```
Returns `WalletTransfer` whose `.leaves: WalletTransferLeaf[]` wraps the new
leaves (`types-CPXB2AOW.d.ts:1083-1107`). ppwallet currently throws away
everything except `.id` (see `sparkWallet.ts:125`). We'll widen the wrapper
to surface the leaf array.

### Historical inspection
```ts
wallet.getTransfers(limit, offset, createdAfter?, createdBefore?)
```
`types-CPXB2AOW.d.ts:5142-5177`. Each transfer carries its `leaves` — we can
rebuild a proof from any past transfer.

## Field map: TreeNode → SparkUtkProof

| TreeNode field             | type   | usage                                  |
|----------------------------|--------|----------------------------------------|
| `ownerSigningPublicKey`    | 33-byte compressed pubkey | `u_base` in proof          |
| `signingKeyshare.publicKey`| 33-byte compressed pubkey | `operator` in proof        |
| `verifyingPublicKey`       | 33-byte compressed pubkey | target for receiver-side verification |
| `id`                       | uuid   | leaf id (for narration in envelope)    |
| `value`                    | number | sats amount (for narration)            |
| `treeId`                   | uuid   | tree id                                |
| `network`                  | enum   | sanity check Alice & Bob on same net   |

`ownerIdentityPublicKey` is the *wallet's* identity key — same across all
leaves of a wallet. **Don't** use this as `u_base` (that's what step 9a did
as a placeholder); use the per-leaf `ownerSigningPublicKey` instead. The
distinction matters because Spark-UTK binds the proof to a *specific leaf*,
not just a wallet.

## Operator pubkey reality

- `signingKeyshare.publicKey` is the **aggregated FROST pubkey** for the
  operators that hold shares of *this leaf*. It's the right primitive for
  the proof's `operator` field.
- Individual operators (their identities, gRPC endpoints, identifier hex)
  live in `walletConfig.getSigningOperators()` — per-network constants
  hard-coded in `services/wallet-config.ts:217-366`. Not needed for the
  proof itself, but useful for proof *verification* if we ever want to
  cross-check against the SE.
- REGTEST/MAINNET use Lightspark's 3-operator coordinator (different sets
  per net). LOCAL uses 5 hard-coded localhost operators (hermetic testing
  only).

## Networks

| Network  | SDK status                | SSP                                | Faucet path                      |
|----------|---------------------------|------------------------------------|----------------------------------|
| MAINNET  | works                     | `https://api.lightspark.com`       | real sats only                   |
| REGTEST  | works                     | `https://api.lightspark.com`       | unknown — no public faucet found in SDK; likely needs Lightspark-coordinator-side provisioning |
| LOCAL    | needs hermetic operator setup | `http://127.0.0.1:5000`         | `BitcoinFaucet` test util — but requires 5 local operator processes |
| TESTNET  | enum exists, no config    | —                                  | —                                |
| SIGNET   | enum exists, no config    | —                                  | —                                |

**Funding strategy for chunk-α**: easiest path is MAINNET with a small
amount the operator already controls. The user has a custodial wallet at
`wallet.pprgb.app` whose seed is the same nsec — logging into rgb-spark
with that nsec on MAINNET will surface the same leaves directly via
`getLeaves()`. No funding step needed.

If MAINNET is off-limits for the demo, REGTEST funding requires reaching
out to Lightspark or running our own regtest tree — not tractable tonight.

## Chunk-α plan

Scope: bind the demo proof to a **real Spark leaf**, with receiver-side
mathematical verification. Defer RGB state transitions, validators,
SDK monkey-patching, and the µ-tweak hook to later chunks.

1. **Widen `sparkWallet.ts`** to expose a `listLeaves()` helper that calls
   `wallet.getLeaves(true)` and returns the `TreeNode[]` (hex-stringified
   `ownerSigningPublicKey`, `signingKeyshare.publicKey`, `verifyingPublicKey`
   per leaf).
2. **Surface a leaf picker** in the Consignment Lab: dropdown of the
   wallet's current leaves with id/value/owner. User selects one.
3. **Build the proof** from `(leaf.ownerSigningPublicKey,
   leaf.signingKeyshare.publicKey)`. Envelope bumps to v3, adds
   `leafReference: { id, treeId, value, verifyingPublicKey, network }`
   so receiver can sanity-check + display.
4. **Receiver-side verification**: when decoding, call
   `deriveVerifyingKey(decoded.uBase, ZERO_MSG, decoded.operator)` and
   compare to `envelope.leafReference.verifyingPublicKey`. Green badge
   "proof verifies against claimed Spark leaf (msg=0)". This is the
   crypto-airtight part — receiver can't fake the leaf existence without
   coordinating with the SE.
5. **Caveats panel** in UI: msg=0 means this is a "trivial-tweak" proof.
   Real Spark-UTK requires injecting a non-zero msg at leaf creation,
   which the stock SDK doesn't allow. Step 9c-bis covers SDK fork /
   monkey-patch.

Estimated time: 1-2 h of code, assuming MAINNET seed works for funding.

## What chunk-α does NOT do

- No RGB state transition (issuance, transfer ops, contract data). The
  envelope still only carries a proof + leaf reference, not an actual
  consignment with stash.
- No rgb-consensus validator running client-side. Verification is just
  the SparkUtk derivation comparison; the full RGB consensus rules
  aren't exercised.
- No SDK fork / non-zero msg. Proof's `msg` is fixed at all-zeros, which
  means we're demonstrating Spark-leaf binding, not Spark-UTK binding.
- No signing operator cross-check. Receiver trusts that the leaf
  reference is real; doesn't query the SE to confirm.

These are chunks β, γ, δ — multi-session work after α lands.
