# Why RGB on Spark

A positioning brief for retail-grade RGB asset issuance and trading.

> **Thesis.** Lightning is a payment network between *known* parties.
> Spark is a balance network between *anonymous* parties. Retail asset
> trading is the second case, not the first.

---

## 1. The trust-model spectrum

| Layer | Custody | Mobile-native | Asset privacy | Cross-counterparty trading |
|---|---|---|---|---|
| **Solana / pump.fun** | non-custodial wallet, fully public chain | yes | none (fully transparent) | native but fully surveillable |
| **Liquid** | custodial-federated (functionaries hold the multisig) | no credible mobile wallet | confidential amounts + assets (real edge) | yes, on-chain |
| **RGB-on-Lightning** | self-custody, but channel-bound | partial (LSP-dependent) | RGB state is private; channel graph is public | only via routable channel graph |
| **RGB-on-Spark** | self-custody, unilateral L1 exit | yes, by design | RGB state private; operators see Spark graph | yes, via Spark HTLC primitive |

The two collapses that matter for product positioning:

- **Liquid ≠ Spark.** Both involve federations, but Liquid functionaries
  custody the satoshis; Spark operators only coordinate signatures while
  the user keeps the leaf key and a unilateral exit path to L1. The word
  "federation" has been burned by Liquid's model; Spark's framing should
  be "self-custody Bitcoin with federated coordination."
- **Trustlessness is not binary.** Spark sits between Lightning (fully
  trustless against your counterparty, fragile UX) and Liquid (no exit,
  smooth UX). It picks self-custody + acceptable UX as the design point.

---

## 2. Why Spark wins for retail mobile asset trading

What a retail trader actually needs:

1. **Open the wallet, see a balance, trade in two taps.**
2. **No state to babysit** when the screen is off.
3. **Trade with any counterparty**, not only those in a channel graph.
4. **Receive a new asset that did not exist five minutes ago** without
   provisioning anything.

Spark satisfies all four:

- No channels to open, fund, watch, rebalance, or close.
- Async receive is native — the receiver does not have to be online for
  the sender to deliver.
- HTLC swaps across Spark exist as a protocol primitive
  (`swapNodesForPreimage` with empty invoice), enabling trustless asset
  swap between two anonymous parties whose only shared knowledge is a
  preimage commitment.
- A newly issued RGB asset is immediately tradable: no channel needs to
  be opened against it, no liquidity needs to be provisioned per asset.

These are not implementation details. They are the shape of the
underlying network. Lightning and Spark are different networks; one is
shaped for payments between known parties, the other for balances
between anonymous parties.

---

## 3. Why RGB-on-Lightning is structurally wrong for retail asset trading

This is not a criticism of RGB-LN as a technology. RGB-LN is the right
construction for *its* use case — payments and swaps between
counterparties who already share a channel graph, with professional
liquidity providers. It is the wrong construction for retail asset
trading. Four reasons:

### 3.1 Channel liquidity does not scale per-asset

For trader A to trade asset X with trader B, the path A → … → B must
exist *and every hop must have liquidity in asset X on both sides*. For
a long-tail asset issuance platform (where a new token may exist for
hours before it stops mattering), nobody will provision channels for it
in advance. The channel graph cannot keep up with asset creation.

### 3.2 Channels require always-online state

A Lightning channel is an adversarial cryptographic protocol. If the
holder of a channel is offline, the counterparty can attempt to publish
a stale state and steal funds. The mitigation (watchtowers, force-close
monitoring) is real infrastructure. Mobile devices are not always
online. This is why mobile non-custodial Lightning has taken four years
of engineering by Phoenix, Breez, and others to reach barely-acceptable
UX for BTC payments alone — adding RGB on top makes it worse.

### 3.3 Channel reserves block working capital

To trade 0.01 BTC of TOKEN-XYZ, the trader needs an open channel to an
LSP that supports TOKEN-XYZ, with provisioned liquidity on both sides
of that channel. For a token that came into existence four minutes ago.
This is not a UX problem — it is a structural impossibility.

### 3.4 LSP-mediated mobile Lightning collapses to a similar trust profile

The pragmatic answer to mobile RGB-LN is to use an LSP that runs the
node on the user's behalf. But the LSP can refuse to route, force-close
unilaterally, or simply go offline. The trust profile is then
comparable to Spark — *except the user still pays the full UX cost of
channel management*. You get neither the trustlessness benefit of pure
LN nor the UX benefit of Spark.

**Net.** RGB-LN is excellent for "payments between known parties with
professional liquidity" (a real and valuable category). It is the wrong
substrate for "long-tail asset trading by retail users on phones."

---

## 4. Why Solana / pump.fun is the wrong baseline to copy

Solana is non-custodial and has produced the dominant retail asset-launch
experience to date. But it is the wrong target for an asset trading
platform that takes user experience seriously, on two axes:

### 4.1 Total on-chain transparency is hostile to traders

Every wallet's full history, holdings, and live trades are public and
indexable in real time. The result, observable in production:

- **Wallet sniping.** Bots track known whale addresses and front-run
  every buy and sell.
- **Bag visibility.** Anyone clicking on a trader's address sees their
  exact position size, instantly.
- **Behavioral fingerprinting.** Trading patterns identify a user
  across all of their wallets.

The professional response is to maintain dozens of wallets and burn
each one after a few trades. This is privacy by exhaustion, not by
design.

A platform where retail traders are *not* trackable across sessions is
a concrete commercial advantage, not a philosophical one. It is what
sophisticated Solana traders already build for themselves manually.

### 4.2 Solana's "non-custodial" claim is shallow

Token contracts on Solana routinely retain mint authority, freeze
authority, and upgrade authority by default. Many "decentralized"
tokens can be frozen at the issuer's request. The wallet holding the
token may be self-custodial; the *asset* held in it is not.

RGB's client-side validation model is structurally different: the
asset's state is validated by the holder against a deterministic
consensus, with no central authority that can flip a freeze bit.

---

## 5. The Spark + RGB design point

Putting it together, what RGB-on-Spark gives a retail asset trading
platform:

- **Self-custody.** User holds the key. Unilateral exit to L1 is
  guaranteed by Spark's exit-path construction.
- **Client-side validated assets.** No mint freeze, no upgrade
  authority, no central issuer override. RGB state is what its history
  cryptographically proves it is.
- **Mobile-native.** No channels, no always-online requirement, no
  watchtowers.
- **Open counterparty set.** Trade with anyone advertising on the
  orderbook relay; no channel graph required.
- **Asset issuance in seconds.** New RGB asset is tradable immediately;
  no provisioning of liquidity-per-asset across a network.

The price of this design point is honest and worth stating up front:

- **Liquidity is bounded by Spark operator capacity**, not by the
  user's own funds.
- **Operators see the Spark balance graph** in cleartext — privacy vs.
  operators is weaker than Monero or even Liquid Confidential
  Transactions. Privacy vs. *the public market* (other traders, bots,
  indexers) is much stronger than Solana.
- **HTLC swaps depend on operators not censoring** the swap step.
  Funds remain safe under censorship; the swap simply fails.

A defensible one-line framing: *"Privacy against the market, not
against the state."* This matches what the overwhelming majority of
retail traders actually need.

---

## 6. Privacy roadmap

The privacy gap relative to Monero is real, and partly closable without
protocol changes to Spark. The work-program, in order of impact-to-cost:

1. **Ephemeral Nostr identity per trade.** Eliminates cross-session
   linkability on the orderbook relay. Largest visible privacy win,
   smallest implementation cost.
2. **Stealth-address derivation on the RGB side.** Extends the existing
   Spark-UTK keytweak primitive so receivers expose only a scan key,
   not a persistent npub. Removes "wallet X received Y of token Z" from
   public observability.
3. **Tor / proxied transport by default** for relay and Spark operator
   connections. Removes IP-level correlation.
4. **Single-denomination leaf trading.** Reduces amount-fingerprinting
   against operator coalitions.
5. **Cover-traffic HTLC chains** between cooperating peers. Dilutes
   (but does not erase) operator graph visibility.

Items 1–3 are achievable as wallet-only changes. Items 4–5 require
protocol-level coordination. None require modification of Spark itself.

---

## 7. Position vs. Kaleidoswap

Kaleidoswap is the most credible RGB-on-Lightning trading project. It
is not a competitor to RGB-on-Spark; it occupies an adjacent product
category:

- **Kaleidoswap.** RGB asset swaps over Lightning channels.
  Counterparty set is the channel graph. Optimized for a small number
  of high-liquidity assets traded by users who accept channel-management
  overhead. Strong trustlessness properties (no operator coalition can
  censor a swap). Excellent for institutional or semi-professional
  trading flows.

- **RGB-on-Spark.** RGB asset balances and swaps over Spark. Counterparty
  set is any wallet on the network. Optimized for long-tail asset
  issuance and retail mobile trading. Accepts a softer trust model
  against operators in exchange for materially better UX and a much
  larger reachable counterparty set.

A coherent narrative for the RGB ecosystem as a whole:

> "RGB-on-Lightning is the institutional-grade trading layer.
> RGB-on-Spark is the retail mobile layer. They share the same
> client-side-validated asset model; they pick different transports
> for different user populations."

The two designs are complementary, not substitutes. The RGB working
group benefits from both reaching production.

---

## 8. What this brief is not

- Not a claim that Spark is more trustless than Lightning. It is not.
- Not a claim that RGB-on-Spark is private against Spark operators. It
  is not, today.
- Not a claim that Solana is unsafe. It is non-custodial; it is simply
  surveillable, which is a different problem.
- Not a competitive attack on Kaleidoswap. Their design is correct for
  the population they target.

This brief is a claim about *fit*: that retail mobile asset trading is
a distinct product category, that no existing RGB transport serves it,
and that Spark is the substrate where it becomes shippable.
