# Spark-UTK: An RGB Single-Use-Seal for Spark Leaves

> Status: Draft RFC · Version 0.2 · 2026-05-10
> Author: PPRGB (operator)
> Target audience: RGB working group (Federico Tenga et al.), Lightspark, RGB
> wallet implementers
> Companion artifacts: `research/` PoC scripts, `FINDINGS.md` (validation log)
>
> **Changelog**
> - **v0.2** (2026-05-10): Tag string versioned to `"Spark-RGB-UTK-v1"` for
>   forward-compatibility across future seal revisions. Strengthened the POP
>   discussion in Security analysis — adding POP at the SE does **not** lock
>   funds (the user knows `dlog(U_tweaked)` and can sign any challenge). The
>   tag-versioning point came from an external review (Kimi K2.6).
> - **v0.1** (2026-05-07): Initial draft.

## Abstract

We propose **Spark-UTK** (User-Key Tweak), a new single-use-seal closing
mechanism for RGB that lets a Spark leaf carry RGB state with the same
unilateral-exit guarantees as a classical RGB UTXO. The commitment rides
inside the leaf's `verifyingKey`, the FROST-aggregated public key the
Spark Service uses to authorize signing. Because the Spark Service
accepts arbitrary user-side pubkeys without proof-of-possession (verified
on Lightspark's regtest **and** mainnet SE), no Spark protocol change is
required. Existing rgb-lib / rgb-consensus need a new seal type but no
new cryptographic primitive.

The result: an RGB asset can be **issued, transferred, split, received,
and unilaterally exited** while held entirely inside Spark. Settlement
is instant and free between Spark wallets; exit produces a normal L1
UTXO whose taproot output key carries the RGB commitment, observable by
any verifier given the off-chain consignment.

## Motivation

RGB today closes seals against L1 UTXOs (`tapret1st`, `opret1st`). Any
L2 system that holds value off-chain — Lightning channels, Ark VTXOs,
Spark leaves — has to bolt RGB on with auxiliary state (server-tracked
allocations, expiring carriers, custodial bookkeeping). Each compromise
trades self-custody for UX.

Spark gives us a unique opening: every leaf already commits to an L1
exit via `p2tr(verifyingKey, no-script)`. If we can route the RGB
commitment into `verifyingKey` itself, the L1 unilateral exit
**automatically** carries the commitment without any added layer.

## Background: Spark deposit address derivation

A Spark leaf is anchored at L1 by the user's *eventual* exit transaction.
The terminal output of the exit chain is

```
verifyingKey = userPubkey + operatorPubkey       (FROST aggregation, 33-byte compressed sum)
L1 output    = p2tr(verifyingKey_xonly, ∅)        (BIP341 with empty merkle root)
```

`userPubkey` is supplied by the user when calling
`generateDepositAddress` on the Spark Service. The SE returns
`(L1 address, verifyingKey)` and stores `(userPubkey, operatorPubkey)`.
**The SE accepts any `userPubkey` blindly** — there is no proof-of-
possession challenge, no signature requirement, no key registration
(verified live, see `research/05-tweak-test.mjs`).

This is the gate that, if open, makes Spark-UTK trivially feasible. It
**is** open.

## Construction

### 1. Commitment derivation

Given an RGB Merkle root `m` for the state to commit to (per the standard
RGB consensus rules), and the user's "base" pubkey `U_base`:

```
t = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ m)     // 32 bytes
U_tweaked = U_base + t · G                           // 33 bytes compressed
```

The user submits `U_tweaked` (not `U_base`) when generating the deposit
address. The SE — being agnostic — proceeds normally:

```
V = U_tweaked + operatorPubkey                       // verifyingKey
A = p2tr(V_xonly, ∅)                                  // L1 deposit address
```

### 2. Verifier reconstruction

Given the off-chain RGB consignment (which provides `m`, `U_base`, plus
the standard state lineage), and the Spark history (which exposes
`operatorPubkey` and `verifyingKey` for the leaf), a third party can
reconstruct:

```
t' = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ m)
V' = (U_base + t'·G) + operatorPubkey
```

and check `V' == V`. If the leaf has been unilaterally exited, the
verifier additionally checks the L1 output key:

```
output_xonly = computeTaprootKeyNoScript(V'_xonly, ∅)  // BIP341 noscript tweak
```

against the actual exit transaction's output. This is the same logic
existing RGB validators run for `tapret1st` seals; only the verifying
key derivation is new.

### 3. Operations

| Operation | Spark primitive | RGB-side action |
|---|---|---|
| **Issue** | Deposit with `U_tweaked` for initial-supply commitment | Create genesis consignment; off-chain |
| **Send full leaf** | Standard transfer (verifyingKey preserved across receiver-side key share rotation) | Forward consignment to receiver |
| **Send partial** | `requestLeavesSwap` → fresh leaves with new user-side keys → re-tweak each child leaf with the appropriate `m_child` | Split consignment into change + send |
| **Receive** | `claimTransfer` | Validate received consignment's `m` against new leaf's `verifyingKey` |
| **Exit** | `buildUnilateralExitChain` | Commitment surfaces in L1 output key automatically |

The transfer flow is the most subtle: Spark transfers rotate the
*receiver's* secret share but **keep `verifyingKey` constant** (statechain
model). For RGB this means a full-leaf transfer naturally preserves the
commitment without the receiver needing to re-tweak. Partial transfers
require split, which goes through the SSP and yields fresh leaves with
fresh user-side keys — at that point, each child leaf gets its own
`U_tweaked` derived from its own RGB sub-commitment.

### 4. Why this is a new seal, not a tweak to `tapret1st`

`tapret1st` commits to RGB state in the *script path* of a taproot output
(an `OP_RETURN` baked into a script-path leaf). Spark uses
`p2tr(verifyingKey, no-script)` — there *is* no script tree to hide a
commitment in. We have to commit through the key path itself.

This is structurally similar to `pubkey-only` ("p2c" / pay-to-contract)
schemes already used in cross-chain protocols, and to the existing RGB
`opret` discussion of key-path commitments. The novelty here is doing it
*before* FROST aggregation — the user's contribution to the aggregate is
the carrier, and the operator's share is unaware.

## Security analysis

**Cryptographic soundness.** `t` is committed-to by `U_base` and `m` via
a tagged hash; `U_tweaked` is `U_base + t·G`. To forge a different `m'`
with the same `U_tweaked`, an attacker must find `t'` such that
`U_base + t·G = U_base' + t'·G`, i.e. solve a discrete-log relation —
infeasible. The tagged-hash domain separation protects against
cross-protocol commitment collisions.

**SE trust.** Spark-UTK does not increase the SE's authority. The SE
already controls `operatorPubkey` and could in principle collude with a
malicious deposit attempt. But because the commitment is on the
*user's* side of the aggregation, an SE that wants to alter the RGB
state must change `verifyingKey`, which would break every standard
Spark exit guarantee — a self-defeating attack.

**No proof-of-possession (today).** The current SE accepts `U_tweaked`
without requiring the user to prove knowledge of its discrete log. This
is fine: an attacker who submits a random `U_tweaked` they don't control
will just lock funds they can never sign for. No external party loses
anything.

**Forward-compat: SE adds POP.** A future SE hardening that mandates POP
does **not** break Spark-UTK. The user knows
`u_tweaked = u_base + t (mod n)` (they hold `u_base`'s discrete log and
computed `t` themselves), so they can sign any Schnorr challenge the SE
issues against `U_tweaked`. POP-on therefore reduces to a wallet-side
plumbing change (compute `u_tweaked`, sign challenge), not a fund-lock
event. The only SE-side change that would actually break this construction
is a modification of the FROST aggregation rule itself — but that would
break every Spark wallet, not just RGB-bearing ones, so it is shared risk
with the rest of the Spark ecosystem rather than a Spark-UTK-specific
exposure.

**Replay across leaves.** `m` ties to a specific RGB state lineage; the
tagged-hash binds `U_base` so the same `m` under a different user
yields a different `t`. Two users issuing the same RGB state get
distinct `U_tweaked` and therefore distinct leaves.

**Exit privacy.** `V` looks like a normal taproot output; observers
cannot tell a Spark-UTK leaf from a vanilla Spark leaf without the
consignment. Same privacy properties as `tapret1st` exits today.

## Off-chain consignment transport (out of scope)

Spark-UTK only addresses the *commitment* side. Consignments still need
to flow from sender to receiver. Three viable transports:

1. **Server pigeon-hole** — a small endpoint (e.g.
   `/rgb-consignment/{recipient_npub}`) where senders post and receivers
   poll. Simplest; matches the existing PPRGB infrastructure.
2. **NIP-04 / NIP-44 over Nostr** — encrypted DM keyed on the recipient's
   identity pubkey (which is also their Spark identity). Decentralized;
   fits naturally with Spark's identity model.
3. **Direct WebRTC** — most private, most operationally complex.

This RFC is **transport-agnostic**. The reference implementation will
ship with (1) and document (2).

## Backward compatibility

Spark-UTK is a new seal type. Existing rgb-consensus / rgb-lib do not
recognize it. Two scenarios:

- **Closed-loop Spark RGB**: assets issued under Spark-UTK never touch
  Bitmask. Works today with a forked rgb-lib. No spec change needed
  upstream.
- **Bridged interop**: a wrapper protocol mints Bitmask-side wrapped
  assets when Spark-UTK assets are exited and burned. Needs explicit
  bridge logic; not in scope here.

The proposed canonical resolution is to **add Spark-UTK to upstream
rgb-consensus** as a new seal variant. Implementation effort:

- New `SealClosingMethod::SparkUTK` variant
- Verifier wire-up: derive `U_tweaked = U_base + t·G`, then run the
  existing taproot key-path verifier
- Wallet wire-up: tweak before submission to the Spark SDK; carry
  `U_base` alongside the consignment

No changes to commitment cryptography (it's still tagged-hash + scalar
multiplication, primitives RGB already uses).

## Reference implementation plan

Three artifacts, sequenceable:

1. **rgb-lib fork** (`rgb-lib-spark` branch): add the new seal,
   validator, and round-trip serialization. Run existing test suite plus
   new fixtures for the Spark path.
2. **`pprgb-wallet`** (TypeScript): minimal SDK wrapping the forked
   rgb-lib (via Node bindings) and the Spark SDK. Demonstrates issue /
   transfer / split / receive / exit on regtest and mainnet.
3. **Compatibility test vectors**: deterministic test cases (`U_base`,
   `m`, expected `U_tweaked`, expected `V`, expected L1 address) so any
   implementer can self-validate.

Estimated calendar: ~3 weeks for (1), ~1-2 weeks for (2), ~2 days for
(3) — assuming a single experienced Rust developer for (1) and one TS
developer for (2). All three can run in parallel after the spec is
frozen.

## Open questions

- **Exit replay protection**: nothing in the construction prevents a
  user from claiming the same RGB state under two different unilateral
  exits if they have access to two leaves committed to the same `m`.
  Today's RGB consensus likely already handles this via state lineage,
  but it should be explicit in the spec.
- **State assignment vs. amount-conservation**: the RFC currently treats
  `m` as the full Merkle root of the post-state. A finer factoring
  (commit only to the amount, leave the assignment data off the leaf)
  may give better privacy at the cost of a slightly different verifier
  protocol.
- **Lightspark SE policy stability**: issuance currently relies on the
  SE accepting arbitrary user pubkeys without POP. POP added later does
  not break the scheme (see Security analysis — the user knows
  `dlog(U_tweaked)` and can sign challenges); only a change to the FROST
  aggregation rule would, and that is shared risk with all Spark wallets
  and therefore implicitly out of scope here.

## References

- Validation log: `FINDINGS.md` (this repository)
- Live PoC scripts: `research/0[1-6]-*.mjs`
- BIP341 (Taproot): https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki
- RGB consensus: https://github.com/RGB-WG/rgb-consensus
- Spark SDK: https://github.com/buildonspark/spark-sdk
