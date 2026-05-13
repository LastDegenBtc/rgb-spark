# RGB-SPK

Pure-P2P trading platform for RGB assets on Spark.
Self-custody, browser-native, no bonding curves, no node, no channels.

This document is the product-vision sibling of
[`RGB-ON-SPARK.md`](./RGB-ON-SPARK.md) (the technical state +
architecture) and [`SPARK-UTK.md`](./SPARK-UTK.md) (the
cryptographic primitive). It scopes the consumer-facing product
that will be built **on** rgb-spark, as a separate codebase, when
the prerequisites land.

The intended audience: future contributors to RGB-SPK, anyone
deciding whether to ship liquidity into the platform, and Tenga /
Lightspark conversations about the consumer-product layer above
the protocol primitives.

---

## 1. The product, in one paragraph

**RGB-SPK lets anyone create an asset and trade it P2P with no
node, no channels, no L1 fee per trade, and no custodian.** Open a
browser tab, generate a wallet, name a token, set a supply, hit
issue. Your asset is live. Post asks at any price; matched buyers
settle atomically against your wallet via Spark-native HTLCs. See
real-time activity on every asset — recent trades, current
holders, depth, VWAP — and act on it.

The product surface is asset-centric, not wallet-centric. The
default screen isn't "your balance and addresses"; it's "what's
trading right now, what's hot, what just launched."

---

## 2. What RGB-SPK is NOT

The category is crowded with adjacent products that look superficially
similar. Stating what RGB-SPK isn't, up front, prevents the wrong
mental model.

- **Not pump.fun.** pump.fun has a bonding curve that manufactures
  liquidity algorithmically. RGB-SPK has a real orderbook with real
  P2P trades. No fake liquidity. No "graduation" to a real market —
  the market exists from second one.
- **Not custodial.** Funds and asset state stay in the user's
  wallet. The orderbook relay never holds anything; the consignment
  relay forwards bytes; the matching engine signs nothing the user
  hasn't pre-signed.
- **Not a node wallet.** No `bitcoind`, no `rgb-cli`, no Lightning
  daemon, no port forwarding. The browser is the wallet.
- **Not Lightning.** Spark is a separate L2 with its own
  coordinator-based settlement model. Faster than LN for small
  trades, no channel management, but a different trust posture
  (Spark operators, not LN routing).
- **Not L1-anchored per trade.** Every trade settles via Spark
  HTLC, no Bitcoin block per swap. Unilateral exit to L1 remains
  available via each leaf's pre-signed refund tx.
- **Not multi-asset-type at v1.** Only NIA (Non-Inflatable Asset)
  in the first release. IFA, CFA, UDA can extend later.

---

## 3. Differentiation thesis

> **Pure P2P liquidity, dramatized.**

The pump.fun thesis: users will trade against a bonding curve
because the curve guarantees price action and exit. The
manufactured liquidity creates the FOMO loop. Without the curve,
early-stage assets feel dead and nobody trades.

The RGB-SPK counter-thesis:

1. **Real demand is more addictive than algorithmic price.** Seeing
   "Alice just bought 100 X for 50 sats, 8 seconds ago" creates a
   stronger emotional pull than "the curve moved from 0.50 to
   0.55." Humans react to humans, not to functions.
2. **The bonding curve is a casino mechanism.** It exists to keep
   the table alive when no actual market does. The platform that
   only ships if the curve guarantees activity is fragile by
   design.
3. **Visibility creates momentum.** The bootstrap problem ("empty
   orderbook = empty FOMO") is solved by *visualizing every
   signal the relay already has*: trade frequency, holder growth,
   depth, recent issuance, time-since-last-trade. The relay sees
   all of these — the UI just has to dramatize them.

The risk: in the first 48 hours of an asset's life, if NO trades
happen, no amount of dramatization saves it. Section 5 covers the
launch-mechanics design for that.

---

## 4. Concrete FOMO signals

Each signal is a specific UI element backed by a specific data
source, with a stated update cadence. None require a bonding curve;
all derive from real P2P activity broadcast by the orderbook /
consignment relay.

### 4.1 Trade ticker

Live feed at the top of the asset's detail page, similar to a
crypto exchange's "recent trades."

- **Data source**: `/order/:assetId` matched orders, sorted by
  `updatedAt` desc.
- **Display**: `Alice (npub1ab…cd) bought 142 SPRK for 78 sats — 12s ago`
- **Update cadence**: 2-second polling, or SSE if the relay
  supports it. The relay broadcasts a match event; UI prepends to
  the ticker with a brief flash animation.
- **Anonymization knob**: optional — show only `someone bought` if
  the npub prefix is in a "do not display" list (user-controlled).

### 4.2 VWAP (volume-weighted average price)

The "real" price for the asset, calculated from the last N hours of
matched trades.

- **Data source**: same match feed, weighted by `amount`.
- **Display**: prominent number at the top of the asset page.
  Color-coded green if up vs 24h ago, red if down. Sparkline below.
- **Update cadence**: recompute on each new match.
- **Edge case**: < 3 trades in the window → show "not enough volume
  for VWAP" with the last-traded price as a fallback.

### 4.3 Holder count

How many unique wallets currently hold a non-zero balance of the
asset.

- **Data source**: deriving from match history is approximate
  (you don't know if a holder later transferred off-platform).
  Better: a registry of self-reported holders, or aggregating
  pathTweaks via a (privacy-aware) opt-in API.
- **Display**: `47 holders · +12 today`
- **Update cadence**: every minute.
- **Privacy**: opt-in. A user can hold an asset without showing up
  in the count; default = show. To be debated.

### 4.4 Asset issuance feed

The "what just launched" firehose.

- **Data source**: a registry endpoint on the relay; emits every
  new `contractId` observed in posted orders.
- **Display**: a side panel showing the last 20 launched assets,
  with ticker / name / supply / first ask price (if any) / time
  since launch.
- **Update cadence**: 5-second polling.
- **Filter knobs**: hide assets that have 0 orders posted after
  N minutes (cuts noise from un-traded experiments).

### 4.5 Activity heatmap

A snapshot of "where's the action right now" across all assets.

- **Data source**: trades-per-asset in the last 1 hour.
- **Display**: a 2D grid (rows = assets, columns = time buckets of
  10 min each), cells colored by trade count. The user can spot
  which assets are heating up.
- **Update cadence**: every minute.

### 4.6 Order book depth

Standard exchange-style bid/ask ladder.

- **Data source**: `/order/:assetId` open orders, grouped by price.
- **Display**: a ladder showing the top 10 bids and asks, each row
  showing aggregated amount. Spread highlighted.
- **Update cadence**: 2-second polling (or SSE).
- **Honesty**: shows REAL open orders, not synthetic curve points.
  When orderbook is thin, that's visible and honest — encourages
  market-making.

### 4.7 Issuance momentum (24h rolling)

The "is this asset still growing?" indicator.

- **Data source**: holder count delta, trade count delta over
  24h.
- **Display**: `+12 holders · +47 trades · +2,300 sats vol`
- **Update cadence**: hourly recompute.

### 4.8 Featured / trending

Editorial curation slot. Optional, can be auto-derived from §4.7.

- **Display**: top 5 assets by 24h trade count, prominently
  rotated on the home page.
- **Update cadence**: daily refresh.

---

## 5. Launch mechanics — solving the cold-start

A freshly issued asset has zero orders. The signals in §4 are
empty. The asset feels dead. Three design choices to address this:

### 5.1 Issuer-seeded orderbook (optional)

The issuance flow offers the issuer an optional "seed your
orderbook" step: place N asks at K different price levels
spanning a 2x range. The issuer pays no fee for seeding; they're
just providing the initial liquidity at their chosen prices.

- ✅ Trustless: the issuer signs each order with their own nsec.
  Anyone trading against them is just trading P2P.
- ✅ Optional: an issuer who wants pure organic discovery can skip
  it.
- ⚠️ The issuer can wash-trade: place asks then buy against them
  to fake volume. Detection: holder count doesn't move. The UI can
  flag "no unique buyers in last X trades" to expose wash.

### 5.2 Launch coordination window

For assets that want a "launch event": the issuer can publish a
locked-launch announcement. Orders can be posted during the
window but no matching happens until the window expires. At T0,
all eligible orders match simultaneously based on best-price.

- ✅ Creates a coordination event — users wait for the same
  moment.
- ✅ Discourages first-mover advantage manipulation.
- ⚠️ Implementation: the relay needs a "scheduled-match"
  capability. Modest extension.

### 5.3 Featured-on-launch

The platform editorially features assets in their first 48 hours,
giving them prominent UI placement. Not algorithmic; chosen by the
operator team. Optional and can be removed.

- ✅ Solves cold-start for assets the operator wants to support.
- ⚠️ Gatekeeping: who decides what gets featured? Can become a
  rent-extraction mechanism. Best avoided unless transparent
  criteria are published.

---

## 6. Trust model

RGB-SPK inherits rgb-spark's trust posture (see
[`RGB-ON-SPARK.md`](./RGB-ON-SPARK.md) §1):

- **Asset binding**: cryptographic, via Spark-UTK. The user's
  Spark leaf carries the RGB commitment. No oracle.
- **Schema validation**: client-side, via WASM. No resolver, no
  L1 witness.
- **Atomic settlement**: Spark coordinator HTLC. Trust = Spark
  operators.
- **Order matching**: signed orders, relay-enforced policy. A bad
  relay can DoS but not redirect.
- **Asset metadata** (new for RGB-SPK): see §7.

The product-level trust additions, all transport-level (= can be
swapped out without losing security):

- **Registry of assets**: who has issued what. Trust = relay
  doesn't filter / censor. A user can verify the underlying
  consignment bytes themselves.
- **Trade activity feeds**: relay broadcasts match events. Trust =
  relay isn't lying about activity. The user can audit by
  cross-referencing per-order match status.
- **Asset metadata** (logo, description, social links): trust =
  whoever signed the metadata blob. By default, the asset issuer's
  npub. Verifiable via signature.

No new custodial trust. The relay is transport, not custody, at
every layer.

---

## 7. Asset metadata

NIA's on-chain global state carries ticker + name + supply
(extracted via `niaGenesisMetadata`). Everything else — logo,
description, social links, terms — is off-chain.

Proposed structure: a separate metadata document signed by the
issuer's npub.

```json
{
  "contractId": "4214c4f9…",
  "ticker": "SPRK",
  "name": "Spark Test",
  "imageUrl": "https://relay.rgb-spk.app/assets/4214c4f9…/logo.png",
  "description": "A test asset for RGB-SPK launch.",
  "socials": {
    "twitter": "@sprk_official",
    "telegram": "t.me/sprk_chat"
  },
  "createdAt": "2026-05-13T15:00:00Z",
  "signature": "..."  // BIP-340 over canonicalize(rest)
}
```

The relay stores these blobs at `/asset/:contractId/metadata` and
serves them to anyone querying. Storage is opt-in (the issuer
posts it); validation is BIP-340 sig against the issuer's npub
(recovered from the contract's first order on the orderbook).

This is **not** an immutable commitment. The issuer can update
the metadata blob over time (newer signed version wins). For
properties that need to be immutable, encode them in the NIA
contract bytes themselves.

---

## 8. Tokenomics primitives

What RGB-SPK enables, schema-wise. No design choices yet — these
are options the issuer can pick.

| Primitive | Status | Comment |
|---|---|---|
| Fixed supply (NIA) | ✅ ready | Native. Supply set at issuance, can't inflate. |
| Inflation schedule (IFA) | ❌ not yet | Requires IFA schema support in our WASM core. ~2 sessions. |
| Burn mechanism | ❌ not yet | Send to a known-unspendable seal. Possible via existing primitives but UX surface needed. |
| Creator royalty on trades | ⚠️ design | Relay extracts a small percentage; trustless? Probably no — would need a smart contract layer Bitcoin doesn't have. |
| Locked/vesting tokens | ⚠️ design | Time-locked spend via the Spark leaf's `refundTx` mechanism. Feasible but custom. |
| Multi-asset bundling | ❌ not yet | Same-tx assignments to multiple contracts. Schema supports it. |

For RGB-SPK v1, ship fixed-supply only. Other primitives are v2+.

---

## 9. Technical prerequisites (in rgb-spark, this repo)

Before RGB-SPK can be built as a product, the rgb-spark core
needs the following. All are extensions to existing primitives,
not new architecture.

### 9.1 Split-merge (the breaker)

**Why it's load-bearing:** today, a NIA transition moves the full
prior allocation to a single recipient. No way to send 2 units out
of 10,000 to a friend. For RGB-SPK, where fractional ownership is
the entire point, this is mandatory.

**Scope:**

- WASM API: `buildNiaTransitionMultiOutput(prevHex, prevGenesisHex,
  consumeIndex, outputs: [{amount, beneficiary_txid, beneficiary_vout}])`
  — accepts a list of outputs. Schema validator already supports it.
- `PathTweakEntry` gains an `amount` field — the leaf carries N
  units, not necessarily the full supply.
- `StashTransition` tracks per-output allocations.
- `settlementAutoEmit.ts` builds T_new with two outputs (buyer +
  self change) when the seller's holding > order amount.
- `assetBinding.ts` `findBoundLeaf` and `lazyRebindIfNeeded` adapt
  to handle leaves carrying partial allocations.
- UI: stash shows "N units of asset X" instead of "asset X
  bound".

**Effort estimate**: 4-5 sessions. Decomposable.

### 9.2 Partial fills in the orderbook

**Why:** if Alice posts an ask for 1000 X at 5 sats/X and Bob wants
to buy 100, the matching engine today refuses (exact-amount). For
RGB-SPK we need partial matching.

**Scope:**

- Relay matching: accept bid amount < ask amount; mark the ask
  partially-filled with `remaining` field.
- HTLC settlement: split-merge means the seller can lock just the
  partial amount; the rest stays in their wallet.
- UI: partial-fill state visible in order details.

**Effort**: 1-2 sessions, depends on split-merge being done.

### 9.3 Registry endpoint

**Why:** §4.4 (issuance feed), §4.7 (momentum), §4.8 (trending)
all need a "list of all assets ever seen on this relay" capability.

**Scope:**

- Relay tracks every distinct `contractId` ever observed in a
  posted order.
- New endpoint `GET /registry/assets` returns paginated list with
  basic stats (first-seen, last-trade, 24h volume).
- Optionally: `GET /asset/:contractId/stats` for per-asset metrics.

**Effort**: 1 session.

### 9.4 Real-time relay events (SSE)

**Why:** §4.1 (trade ticker), §4.6 (depth), §4.4 (issuance feed)
all benefit from sub-second update cadence. Polling at 2-second
intervals works but feels sluggish.

**Scope:**

- Relay exposes `GET /events` as Server-Sent Events.
- Events: `order_placed`, `order_matched`, `order_cancelled`,
  `asset_registered`.
- TypeScript client subscribes once at app boot, demultiplexes
  events to interested components.

**Effort**: 1 session.

### 9.5 Asset metadata storage

**Why:** §7 — needs a place to store and serve signed metadata
blobs.

**Scope:**

- Relay endpoint `POST /asset/:contractId/metadata` (signed).
- `GET /asset/:contractId/metadata` returns latest signed version.
- Size cap, BIP-340 verification, npub binding to first-seen
  issuer.

**Effort**: 1 session.

---

## 10. Path from rgb-spark to RGB-SPK v1

Two phases:

### Phase A: Extend rgb-spark (this repo) with the prerequisites.

Sessions, in dependency order:

1. Split-merge WASM core (~2 sessions).
2. Split-merge wallet integration: pathTweaks/stash/auto-emit/rebind (~2 sessions).
3. Partial fills in relay + UI (~1 session).
4. Registry endpoint (~1 session).
5. SSE event stream (~1 session).
6. Asset metadata storage (~1 session).

Total: **~8 sessions** of extension work on rgb-spark.

### Phase B: Build RGB-SPK as a new codebase.

New repository, consumer-grade UX. Vendors the rgb-spark TS libs
+ WASM core. Likely Next.js or similar (for SSR and mobile-first
performance). UX work as scoped in §4 (signals) + §5 (launch
mechanics) + §7 (metadata).

Sessions: TBD when starting. Likely 15-25 sessions for a v1 MVP.

### Phase C: Liquidity bootstrap and launch.

- Ship to closed beta.
- Onboard a few real issuers and traders.
- Stress-test the FOMO signal design with real activity.
- Iterate on launch mechanics from §5.

---

## 11. Open questions

- **Anti-spam on asset issuance**: anyone can issue an asset for
  free. The relay's registry can fill with garbage. Filter by
  "has at least one posted order" before showing in the issuance
  feed.
- **Sybil resistance on holders**: a single user can fragment
  their holdings across N npubs to inflate the holder count.
  Detection: bound to actual P2P trade counterparties, not just
  pathTweak entries.
- **Cross-contract pairs**: if asset X trades for asset Y (not
  sats), the orderbook needs a pair concept. Out of scope for v1.
- **Mobile vs web**: the rgb-spark dev surface is web-only.
  RGB-SPK should probably be mobile-first via PWA. Native apps
  are v2+.
- **Relay operator economics**: who runs the relay? Does it
  charge fees? For v1, probably one operator (us) running it as a
  loss leader. v2+ federated.
- **Brand and legal**: RGB-SPK is the technical name. The
  consumer brand is TBD. Asset issuance with fixed supplies in
  some jurisdictions has securities implications.

---

## 12. Strategic positioning

RGB-SPK competes for the same attention as pump.fun, but with
different trust + UX trade-offs. Honest framing:

- **Where pump.fun wins**: instant liquidity. RGB-SPK has thin
  liquidity in early phases by design. Some users will prefer
  pump.fun's curve for the trade-anywhere-anytime guarantee.
- **Where RGB-SPK wins**: self-custody, no custodial bridge, no
  Solana fees, no fake price action, real ownership of the asset.
  Users who care about these properties will prefer it.
- **Where neither wins yet**: launch mechanics, mobile native,
  zero-friction onboarding. Both are works in progress; RGB-SPK
  has a credible architecture but ships nothing today.

The path from "credible architecture" to "shipping product" is the
~8 prereq sessions + 15-25 RGB-SPK sessions above. Substantial but
deterministic.

---

## 13. Footer

This document is a vision snapshot as of 2026-05-13. None of
RGB-SPK is built. The prerequisites are partially scoped in
rgb-spark; the product codebase doesn't exist yet.

For the current rgb-spark technical state, see
[`RGB-ON-SPARK.md`](./RGB-ON-SPARK.md).

For the cryptographic primitive, see
[`SPARK-UTK.md`](./SPARK-UTK.md).
