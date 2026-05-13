# RGB on Spark

Status, capabilities, and bridge design.

This document is the product-and-architecture sibling of
[`SPARK-UTK.md`](./SPARK-UTK.md) (which covers the cryptographic
primitive in RFC form). It exists to answer two questions:

- **What can rgb-spark actually do today?** — what shipped, validated
  on Spark mainnet, with no L1 footprint per transfer and no payment
  channels.
- **How do we bridge RGB assets between L1 and Spark?** — design
  proposal for the missing piece, with four architectural options
  ranked by trust posture.

The intended audience: anyone trying to understand whether
RGB-on-Spark is a serious construction (it is), how to use it for a
product, and where the open problems are.

---

## 1. What ships today

The construction is **Spark-UTK**: an additive secp256k1 keytweak
applied to the user-side share of a Spark leaf's verifying key,
binding the leaf cryptographically to an RGB commitment (a contractId
or a transition's `commit_id`) before FROST aggregation with the
operator share. The Spark Service Entity aggregates blindly and
never learns the embedded commitment. Details:
[`SPARK-UTK.md`](./SPARK-UTK.md).

Built on top of that primitive, the following loop is closed
end-to-end and validated on Spark mainnet as of 2026-05-13:

### 1.1 Trustless NIA contract issuance

Any wallet can issue a Non-Inflatable Asset contract entirely in the
browser, via `core.issueNiaContract(ticker, name, supply, …)`. The
resulting `contractId` is deterministic from the genesis bytes; the
genesis is the same `Consignment<false>` shape the RGB-WG mainline
rgb-consensus 0.11 produces.

No issuance server, no fee, no L1 anchor. The genesis exists as
client-side bytes that any other party can validate via
`core.niaGenesisMetadata(genesisHex)`.

### 1.2 Spark-UTK leaf binding

A Spark leaf the wallet owns can be bound to a 32-byte RGB
commitment (the contractId for genesis-bound, or a `transition.id()`
for transition-bound leaves). The binding is enforced
cryptographically: the leaf's `verifyingKey` recorded by the Spark
operators equals `deriveVerifyingKey(uBase, msg, operator)`, where
`uBase` is the user's pre-tweak base pubkey and `operator` is the
aggregated operator share. Any party with `(proof.uBase, msg,
proof.operator)` can verify the binding independently — no oracle,
no Spark coordinator query required.

The binding is single-use: it survives one Spark transfer (the leaf
is consumed by transfer), so the asset's "current owner" is a
function of who currently holds the bound leaf. This matches RGB's
one-time seal semantics natively.

### 1.3 Client-side schema validation

State transitions over genesis (and over prior transitions, up to
arbitrary chain depth) are built and validated entirely client-side
through the WASM-compiled `rgb-consensus` schema validator. The
validator runs typesystem checks plus the NIA AluVM `svs OS_ASSET`
conservation check, with the input state map built deterministically
from the prior allocation — no `ResolveWitness`, no L1 witness, no
electrum/esplora resolver. Spark replaces L1 as the transport layer,
not as the validator.

WASM exports cover:

- `buildNiaTransition(genesisHex, …)` — depth-1 transition over
  genesis.
- `buildNiaTransitionFromPrev(prevTransitionHex, prevGenesisHex, …)`
  — depth-N+1 transition over a prior transition.
- `validateNiaTransition(transitionHex, prevGenesisHex)` — replay
  the schema validator on a depth-2 chain.
- `validateNiaTransitionFromPrev(transitionHex, prevTransitionHex,
  prevGenesisHex)` — replay on a depth-3 chain.
- `niaGenesisMetadata(consignmentHex)` — extract validated
  contractId + ticker + name + supply from genesis bytes.

### 1.4 Atomic P2P swaps via Spark HTLC

Spark's `swapNodesForPreimage` coordinator endpoint accepts
`invoiceString: ''` — no Lightning routing, no LSP, no bolt11. We
use it as a generic HTLC primitive: lock leaves under a payment
hash, with auto-refund on expiry and `providePreimage`/`queryPreimage`
endpoints exposing the standard reveal-and-claim flow. The full
asymmetric-timelock atomic-swap dance (seller's lock longer than
buyer's lock + safety margin) runs in `frontend/src/lib/htlcSwap.ts`
with structured observable phase transitions.

This gives us, on Spark, the same atomicity property L1 has via
PSBTs and Lightning has via HTLC routing — without channels or
routing fees.

### 1.5 Signed orderbook (no first-mover trust)

`relay/src/orderbook.ts` accepts BIP-340-signed orders, enforces
exact-price-AND-amount matching (FIFO within a price level),
refuses self-matches by npub, and serves as a pure transport for
order discovery. The relay never holds funds and cannot redirect
payments: the counterparty Spark identity pubkey is committed in
every order's signature, so a bad relay can DoS the book but
cannot reroute trades.

A 24-hour TTL cleans up stale orders; signature tampering is
detected server-side via re-canonicalization.

### 1.6 Settlement-coupled consignment auto-emit

At the moment the seller's HTLC settlement completes
(`runSellerFlow` reports `phase: 'completed'`), the wallet
automatically:

1. Recovers the seller's pre-swap pathTweak entry for the locked
   leaf — which carries the chain bytes (`prevGenesisHex`,
   `prevTransitionHex`) the seller used to mint that leaf.
2. Builds T_new (the next transition in the chain) via
   `buildNiaTransitionFromPrev`, allocating the full prior amount.
3. Composes an envelope v4 with `kind: settlement-consignment-v1`
   carrying the proof + the new transition + the chain context,
   BIP-340-signed by the seller's nsec.
4. POSTs to `/consignment/<buyerNpub>` on the consignment relay.

This closes the cross-wallet asset-binding loop: the buyer doesn't
just receive a Spark leaf — they receive the RGB chain evidence
that proves the seller indeed had the right to sell.

### 1.7 Buyer-side inbox + auto-stash

The buyer's wallet runs an 8-second background poller against
`/consignment/<myNpub>`. For each new envelope, it validates:

1. BIP-340 signature.
2. Schema chain via `validateNiaTransitionFromPrev` /
   `validateNiaTransition` (dispatched by chain depth).
3. `msgHex == prevTransition.id()` (cross-check that the seller's
   binding refers to the chain we're seeing).
4. `deriveVerifyingKey(uBase, msgHex, operator) ==
   leafReference.verifyingPublicKey` (Spark-UTK math closes the
   loop: the seller did hold a leaf with that binding).

On success, `addContract` + `addTransition` are called idempotently
on rgbStash, and the envelope is acked off the queue. A
`<ToastHost />` surfaces "+N asset received" notifications.
Rejected envelopes stay on the queue for manual inspection through
the developer ConsignmentLab.

Ticker, name, supply are extracted from the genesis bytes via
`niaGenesisMetadata` — sender-supplied envelope fields are
ignored, so the seller cannot lie about asset metadata in the wire
format.

### 1.8 Lazy rebind on re-sale

When the buyer wants to re-sell the received asset, the
OrderBookPanel's `place(ask)` flow detects "asset in rgbStash but no
live binding in pathTweaks" and silently:

1. Builds T_n+1 over the latest known transition for this contract.
2. Picks the smallest vanilla source leaf as a transfer carrier.
3. Calls `mintViaSelfTransfer` with the fresh T_n+1.id() as `msg`,
   shipping the chain bytes through `MintRgbPayload`.

After rebind, the wallet has a Spark leaf cryptographically bound to
T_n+1, and the ask is posted with that leaf as the asset leg. The
asset cryptographically follows the wallet that holds it — across
an arbitrary number of subsequent trades.

### 1.9 Mainnet validation

Each session was validated on Spark mainnet, with the seller flow
running against the seller's own npub (`reference_spark_htlc_primitive`
constraints make full cross-wallet validation require a fresh second
nsec; piecewise cross-wallet validation done via the HTLC probe in
session 0). Native cargo test suite for the WASM core: 10/10 green
including round-trip vectors. tsc + lint clean.

---

## 2. What this enables

### 2.1 The product hypothesis

> **LN-flavored UX for RGB asset trading, without nodes or channels.**

The end user installs nothing local. They open a browser tab, unlock
or generate a wallet, issue or receive an asset, list it on the
orderbook, get matched, settle atomically, and walk away with the
RGB asset bound to their wallet. The technical layers (HTLC, RGB
schema, keytweak, settlement messaging) are invisible.

What enables that UX:

- No L1 footprint per trade. Every transfer is a Spark coordinator
  operation, completing in seconds.
- No Lightning channels. No capital lockup, no routing fees, no LSP
  trust.
- No node software. Spark's trust model is "Lightspark operators",
  same as using their wallet for sats.
- Asset binding is cryptographic, not custodial. The wallet doesn't
  delegate seal management to a server.

### 2.2 Comparison with adjacent products

| Product | Transport | Trust | Setup cost | Trade fee | Trade speed |
|---|---|---|---|---|---|
| Bitmask (RGB on L1) | tapret on Bitcoin | Bitcoin consensus | none | L1 mining fee | 10 min |
| rgb-lib + LN (Kaleidoswap) | RGB-on-LN with HTLC | Bitcoin + LN routing | Local node + channels | LN routing + RGB layer | seconds |
| **rgb-spark** | Spark-UTK on Spark | Bitcoin + Spark operators | none (browser) | Spark coordinator (minimal) | seconds |
| ppwallet (custodial sibling) | tapret on L1 server-side | Bitcoin + custodian | none | none (custodian eats it) | seconds (server-side) |

The product-positioning lane: same UX target as ppwallet (zero
setup) but self-custody; same speed as Kaleidoswap but no node /
no channels. Different trust model from both, sitting at "trust
Spark operators" — which is bounded, well-understood, and a step
above any custodial option.

### 2.3 What's currently unique

To our knowledge (as of 2026-05-13), no other RGB camp ships any of
the following:

- Trustless asset binding that survives Spark transfer (Spark-UTK).
- Cross-wallet RGB delivery over a non-L1, non-LN transport.
- Browser-side schema validation for transitions of depth ≥ 2
  without L1 witnesses.
- End-to-end atomic swap of RGB assets without a local node or
  LN channels.

Tenga and Bitfinex (the 0.11 mainline maintainers) ship L1 / LN
RGB; Bitlight is on the wire-incompatible 0.12 line. rgb-spark
occupies its own quadrant.

---

## 3. The bridge problem

What's missing for a complete product story: importing an existing
L1 RGB asset INTO rgb-spark, and exporting a Spark RGB asset OUT
to L1.

### 3.1 Why bridging matters

The dominant store of RGB value today is on L1 — Bitmask wallets,
treasuries, OTC desks. Users who already hold L1 RGB are the most
addressable market for a P2P trading layer. If they can't bring
their existing assets into the Spark experience, the product can't
bootstrap.

The bridge is also the lever that lets the same asset benefit from
both L1's settlement assurance (when locking value away) and Spark's
trading UX (when liquid). That's the long-term thesis: pick the
right transport for the right phase of the asset's lifecycle.

### 3.2 Why it's hard

L1 RGB and Spark RGB use the same commitment scheme (RGB
single-use seals + schema validator) but anchor the seals to
different oracles:

- **L1**: the seal is the tapret-tweaked output of a Bitcoin UTXO.
  The witness is the Bitcoin tx that creates that UTXO. The oracle
  is Bitcoin consensus.
- **Spark**: the seal is the additively-tweaked verifying key of a
  Spark leaf. The witness is the Spark leaf's existence in the
  coordinator's state. The oracle is the Spark operators.

To move an asset from L1 to Spark, you have to:

1. Burn the L1 seal (spend the tapret-committed UTXO).
2. Mint a Spark seal bound to the same contract chain.
3. Do both atomically — or accept a trust gap.

The "atomically" part is what makes the four options below
non-trivial.

---

## 4. Bridge design options

Four architectural shapes, ranked by trust posture. Each gets a
honest write-up of pros, cons, and effort.

### 4.1 Option A: Custodial bridge — rejected

A trusted operator runs a bridge: user sends L1 RGB to the
operator's L1 address, operator mints an equivalent Spark leaf,
holds the L1 collateral until the user wants to export. WBTC-style.

- ✅ Simple to build (~1 month).
- ❌ Custodial trust: the bridge can rug.
- ❌ Violates the self-custody premise of rgb-spark.
- ❌ Same trust posture as ppwallet — defeats the point.

**Rejected.** Not pursued. If the user wants a custodial bridge they
can use ppwallet directly; the value of rgb-spark is the
self-custody trust model.

### 4.2 Option B: Spark Operators as RGB-aware bridge

Lightspark adds RGB-awareness to their coordinator. They observe
L1 RGB transfers to a designated address, mint Spark leaves bound
to the same `contractId`. The leaf's pre-signed `refundTx` becomes
the L1 anchor for the Spark side; if the user wants to exit, they
broadcast it.

- ✅ No new trust assumption: Spark operators are already trusted
  for Spark itself. Bridging just extends their responsibility.
- ✅ Simplest UX: the user just transfers L1 RGB to a Spark address.
- ✅ Spark Operators get RGB transaction volume on their L2,
  potential commercial upside.
- ❌ Requires Lightspark buy-in. Not a unilateral decision on our
  side.
- ❌ Coupling: rgb-spark depends on Lightspark's roadmap.

**Strategic, not technical.** This is the conversation to have with
Lightspark once the technical demo is solid. The pitch: "We've
built the trustless RGB layer on Spark, validated mainnet. Add
this endpoint and you get the L1 import market."

### 4.3 Option C: Atomic swap L1 ⇄ Spark — recommended MVP

Two users on opposite sides of the bridge do an atomic swap using
hash-locked contracts on both transports simultaneously. Alice has
L1 RGB asset X, wants Spark version. Bob has Spark RGB asset X,
wants L1 version. Same `contractId`. No third party.

- ✅ Trustless: no operator, no custody. Bitcoin consensus + Spark
  operators (already trusted for Spark) are the only oracles.
- ✅ Implementable today: reuses our `htlcSwap.ts` for the Spark
  side, standard PSBT-HTLC primitives for the L1 side.
- ✅ Composable with the existing orderbook.
- ❌ Liquidity bootstrap: needs counterparties on each side. Hard
  cold-start until the market matures.
- ❌ More complex protocol than B (two transports, two timelocks,
  watchtower-style monitoring on L1 side).

**Recommended MVP.** Detailed protocol in §5 below. Even before
liquidity exists, building this primitive proves the architecture
and gives the future consumer wallet a real product story.

### 4.4 Option D: L1 anchor via tapret in the deposit tx

When the user imports L1 RGB, the L1 deposit transaction to Spark
itself carries a tapret commitment to the RGB bundle. The Spark
leaf is created with a `refundTx` that, when broadcast, re-anchors
the asset back on L1 via the same commitment. No counterparty
needed.

- ✅ Trustless: math closes without third parties.
- ✅ User-driven: no need for a market or operator.
- ❌ Requires either (a) Spark Operators to issue leaves bound to
  a tapret-tweaked output key (SE-side change, out of our control),
  OR (b) the user to maintain an additional L1-anchored deposit tx
  paired with the Spark leaf — adds an L1 footprint per import.
- ❌ Significant R&D: ~3-6 months to validate the math, build the
  resolver, test the failure modes.

**Long-term play.** The cleanest architecture if the SE supports
it. Worth raising with Lightspark in the same conversation as
Option B — they may prefer this over their direct involvement.

---

## 5. Atomic swap L1 ⇄ Spark — protocol spec

This is the protocol for Option C, the recommended MVP. It mirrors
the classical Bitcoin / Lightning atomic swap (Tier Nolan, 2013)
but with one leg on L1 and the other on Spark, and with RGB asset
state carried through both legs.

### 5.1 Roles and parameters

- **Alice** holds L1 RGB asset X with balance N, wants Spark version.
- **Bob** holds Spark RGB asset X with balance N (same contractId,
  via Spark-UTK binding to the same chain root), wants L1 version.
- `P` = random 32-byte preimage, generated by Alice.
- `H = sha256(P)` = payment hash.
- `T_A` = Alice's L1 HTLC timeout (longer expiry).
- `T_B` = Bob's Spark HTLC timeout (shorter expiry).
- `Δ` = safety margin. `T_A ≥ T_B + Δ`. Concrete defaults: `T_A` =
  6 blocks on L1 (~1 h), `T_B` = 30 min on Spark.

### 5.2 Protocol sequence

```
Alice (L1 RGB → Spark RGB)            Bob (Spark RGB → L1 RGB)
─────────────────────────             ────────────────────────

(1) Alice generates P, H.
    Publishes H + offer to orderbook.

                                      (2) Bob matches the order
                                          via the existing
                                          orderbook relay.

(3) Alice broadcasts L1 HTLC tx:      
    spends her tapret-committed
    UTXO into an HTLC output:
    - spendable by Bob with P + sig
      until T_A
    - refundable by Alice after T_A
    bundle: assigns asset X to the
            HTLC outpoint.

                                      (4) Bob observes Alice's L1
                                          HTLC (block confirmation).
                                          Validates: tapret
                                          commitment, bundle,
                                          contractId == X.

                                      (5) Bob locks his Spark RGB
                                          leaf via
                                          `swapNodesForPreimage`:
                                          - receiver = Alice's Spark
                                            identity pubkey
                                          - paymentHash = H
                                          - expiry = T_B
                                          The leaf is bound to the
                                          asset X chain via
                                          Spark-UTK.

(6) Alice observes Bob's Spark HTLC
    via `query_htlc(role=receiver,
    paymentHashes=[H])`. Validates:
    leaf's Spark-UTK binding maps to
    asset X chain.

(7) Alice reveals P on Spark side:
    `providePreimage(P)`. She
    receives Bob's Spark leaf with
    the RGB binding intact.
    Auto-rebind runs: she mints a
    fresh leaf bound to T_n+1.

                                      (8) Bob queries
                                          `query_preimage(H, Alice)`
                                          on Spark, retrieves P.

                                      (9) Bob broadcasts L1 claim
                                          tx: spends Alice's HTLC
                                          output with P + Bob's
                                          sig. The new tx's bundle
                                          consumes the HTLC
                                          allocation and assigns
                                          asset X to Bob's L1 seal.

Both sides settled. Same asset X, same chain, moved transport.
```

### 5.3 Carrying the RGB binding through the L1 HTLC

The L1 HTLC output script is a standard Bitcoin HTLC. The RGB
binding rides via the bundle commitment:

- Alice's input to the HTLC tx: her tapret-committed UTXO with
  asset X allocation.
- The HTLC tx's bundle:
  - Consumes Alice's prior allocation.
  - Assigns asset X (full balance N) to the HTLC outpoint.
- The tapret commitment for the HTLC output: anchored to the
  bundle's Merkle root, normal RGB-on-L1 semantics.
- Whoever spends the HTLC output (Bob with preimage, or Alice on
  refund) builds the NEXT bundle that consumes the HTLC allocation
  and assigns to their own seal.

The RGB schema validator works unchanged: it sees a normal
genesis → T_1 (lock) → T_2 (claim or refund) chain. The HTLC is
transparent to the validator.

### 5.4 Failure modes and refunds

| Event | Outcome |
|---|---|
| Both parties act honestly | Atomic swap completes. Both sides have the asset on the other transport. |
| Alice never broadcasts L1 HTLC | Bob never locks Spark side. No funds moved. |
| Alice broadcasts L1 HTLC, then disappears | After T_A: Alice's refund path on L1 fires (whoever runs her wallet broadcasts the refund). Bob's Spark leaf, if locked, auto-refunds at T_B (< T_A). Both whole. |
| Bob never locks Spark side | After T_A: Alice refunds L1. Bob never had anything at risk. |
| Bob locks Spark, then Alice never reveals P | After T_B: Bob's Spark leaf auto-refunds. After T_A: Alice's L1 HTLC refunds. Both whole, no asset moved. |
| Alice reveals P just before T_B but after T_B − Δ | Edge case: Bob has < Δ to broadcast L1 claim before T_A. With Δ = 30 min and L1 confirmation in 10 min, comfortable. Watchtower needed if Bob is offline. |
| Bob fails to claim L1 after Alice reveals P | After T_A: Alice can refund L1. But P is now public on Spark, so a watchtower (or anyone monitoring) could claim L1 on Bob's behalf. Bob loses if no watchtower; design space for paid watchtower service. |

### 5.5 Liquidity bootstrap

The chicken-and-egg problem: Alice and Bob both need to exist.
Three strategies:

- **Programmatic market maker**: a third party (perhaps the
  orderbook operator) runs both an L1 RGB wallet and a Spark
  wallet, sits on inventory of asset X on both sides, accepts
  swaps in either direction. Custodial-flavored but only for the
  market maker's own inventory, not user funds.
- **OTC channel**: high-volume parties coordinate swaps off-chain
  (Telegram, etc.) and use the atomic-swap primitive as the
  settlement layer. No order book matching, just bilateral.
- **Same-user import/export**: the user creates their own
  counterparty. Alice runs both an L1 wallet and an rgb-spark
  wallet; she swaps asset X from her L1 wallet to her Spark
  wallet, paying transport fees but not market-making fees.
  Bootstrap-mode.

Any of the three is reasonable for v0. We don't have to solve
liquidity to ship the primitive.

---

## 6. Strategic positioning and next steps

### 6.1 What rgb-spark IS

- A reference implementation of trustless RGB on Spark, NIA scope.
- A WASM core + TS SDK that other wallets can vendor.
- A test harness for the Spark-UTK primitive against rgb-consensus
  0.11 mainline (Tenga / Bitfinex line, not Bitlight 0.12).
- An end-to-end demo (lab.pprgb.app) for the RGB-WG conversation.

### 6.2 What rgb-spark IS NOT

- Not the final consumer product. A separate standalone wallet for
  end users will be built on this foundation, with consumer-grade
  UX. The current frontend is dev-targeted.
- Not a fork of RGB. The primitives we add (Spark-UTK keytweak,
  `DbcProof::SparkUtk` variant) are designed to be upstreamable
  into bp-core / rgb-consensus mainline.
- Not multi-asset-type yet. Only NIA is implemented. IFA, CFA,
  UDA are natural extensions but separate work.
- Not split-merge. v0 transitions move the full prior allocation
  to a single recipient.
- Not bridge-ready. §3/§4/§5 above is design only — the bridge is
  unbuilt.

### 6.3 Path to upstream

The Spark-UTK primitive and the `DbcProof::SparkUtk` variant are
new wire-format elements in our fork of bp-core / rgb-consensus.
The proper sequence to upstream:

1. **Stabilize the spec**. `SPARK-UTK.md` is v0.2; iterate to v1.0
   with reviewer feedback.
2. **Open RGB-WG discussion** (Github discussions on the Tenga
   org). Frame as: "we've shipped a working trustless RGB
   transport on Spark; here's the spec, here's the demo, here's
   the PR shape."
3. **PR bp-core first**: just the keytweak primitive
   (`dbc/src/keytweak/mod.rs`). Pure math, no RGB impact. Easier
   first ask.
4. **PR rgb-consensus second**: the `DbcProof::SparkUtk` variant
   (tag `0x03`), method-aware p2tr disambiguation. Bigger ask,
   harder to merge.
5. **Demo runnable**. lab.pprgb.app + cargo test + WASM bundle as
   evidence.

This is months of conversation, not code. The technical work is
mostly done; the diplomatic work isn't.

### 6.4 Path to consumer wallet

A separate codebase, TBD. Built on the rgb-spark TypeScript libs
(`htlcSwap`, `orderbookRelay`, `settlementAutoEmit`,
`settlementInbox`, `assetBinding`, `rgbAwareSigner`, `rgbStash`,
`pathTweakStorage`) plus the vendored WASM core. Consumer-grade UX:
asset-centric, no hex artifacts, identity drawer for advanced
fields, real branding.

The bridge (§4/§5) is a v2 feature for that wallet. v1 ships with
self-issued assets traded P2P among rgb-spark wallets — already a
real product with no peer in the market.

---

## 7. Open questions

- **Multi-asset transitions**. A transition consuming multiple
  inputs from different contracts. NIA schema allows it; our
  WASM exports don't yet expose it.
- **Split-merge**. Selling 50% of an allocation. Requires the
  schema validator to accept multi-output transitions; the math
  is in rgb-consensus, we just don't surface it.
- **Stash size growth**. Same problem as RGB-on-L1: the
  receiver's stash grows O(chain depth × asset count). Parked
  discussion: content-addressed external stash with on-demand
  fetch. Becomes pressing past ~10k transitions per asset.
- **L1 export beyond atomic swap**. Without a counterparty,
  exporting requires a coordinator-side L1 anchor (Option D). Open
  conversation with Lightspark.
- **Watchtower service for L1 leg**. Atomic swaps need someone
  online during the timelock window. The orderbook operator is a
  natural candidate; pricing TBD.
- **Multi-asset orderbook**. Today the orderbook is per-contract.
  Cross-contract pairs (sell asset X for asset Y) would need
  additional matching logic.

---

## 8. Footer

This document is a snapshot as of 2026-05-13. The construction is
stable; the consumer wallet and bridge are unbuilt; the upstream
conversation hasn't started.

For the cryptographic spec, see
[`SPARK-UTK.md`](./SPARK-UTK.md).

For the agent guidance and repo conventions, see
[`CLAUDE.md`](./CLAUDE.md).
