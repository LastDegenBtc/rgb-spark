# sprk.fun — Trader pitch

Commercial arguments against Solana / pump.fun, in trader-language.
For Twitter, decks, or direct pitch.

> **TL;DR.** Pump.fun proved retail memecoins are massive. But Solana
> has 3 structural problems traders deal with every day: MEV bots
> sandwiching your trades, devs that can rug via mint authority, and a
> chain that halts. sprk.fun is pump.fun on Bitcoin — no MEV, no rug,
> no halt — and your PnL is in sats, not in SOL.

---

## The 5 Solana trader pains → sprk.fun answers

### 1. The rug

| | |
|---|---|
| **Solana pain** | "I bought a token, the dev froze the mint, dumped his bag, I was stuck." |
| **sprk.fun answer** | On RGB there is **no mint authority**, **no freeze function**, **no contract upgrade**. The dev can't do anything. Once the asset is issued, his powers = zero. |

**Why this kills** — it is literally impossible to reproduce on Solana.
SPL tokens *have* these authorities by default. Bonk has them. Wif has
them. The dev *can* freeze. On RGB it is not "the dev promises not to
do it" — it is "the button does not exist."

> **One-liner** — *No mint authority. No freeze. No upgrade. Just an asset.*

---

### 2. The sandwich / MEV

| | |
|---|---|
| **Solana pain** | "Every buy gets sandwiched. Jito eats 3-5% slippage on every trade." |
| **sprk.fun answer** | **No public mempool**. **No validators reordering txs**. Your order matches a counterparty directly, period. Nobody can wedge in. |

**Why this kills** — it's quantifiable. Traders know how much MEV costs
them. Solana even institutionalized MEV with Jito. On Spark you have
an orderbook + bilateral HTLC, there is no surface for the sandwich.

> **One-liner** — *Zero MEV. Zero Jito. Zero sandwich.*

---

### 3. The chain that halts

| | |
|---|---|
| **Solana pain** | "Solana halted 6 times in 2024. I was long for 4 hours with no exit." |
| **sprk.fun answer** | We are on **Bitcoin**. Bitcoin has never halted in 16 years. Spark recovers even if half the operators go down. |

**Why this kills** — it's visceral. Every Solana trader has lived
through a halt and shit their pants. Bitcoin = uptime. No debate.

> **One-liner** — *The chain doesn't halt. Your bag isn't hostage to a validator gang.*

---

### 4. The denomination

| | |
|---|---|
| **Solana pain** | "I made +40% on this shitcoin but SOL dumped 30% while I traded — I'm net flat." |
| **sprk.fun answer** | You trade **in sats**. Your PnL is **in BTC**. No middle currency bleeding out while you farm. |

**Why this kills** — it's the 2024–2026 reality. Solana traders who
held in SOL instead of USDC got wrecked. Pricing in sats = pricing in
the only thing that goes up.

> **One-liner** — *Stack sats, not the token that dumps while you trade.*

---

### 5. The boomer wallet

| | |
|---|---|
| **Solana pain** | "Phantom is a chrome extension. I lost funds to a fake popup once. And mobile is garbage." |
| **sprk.fun answer** | **Mobile-first PWA**. You trade from your iPhone. No chrome extension. No seed phrase typed by hand every time. |

**Why this kills** — pump.fun mobile is catastrophic. Phantom mobile
too. You ship iPhone Safari by default, you're already ahead on UX.

> **One-liner** — *Pump.fun is a desktop game. sprk.fun is a wallet in your pocket.*

---

## The 3 to lead with

If you can only fit 3 points in a Twitter thread or elevator pitch:

1. **No rug possible** — technical, quantifiable, viral
2. **No MEV** — technical, quantifiable, viral
3. **On Bitcoin** — emotional, tribal, branding

The first two are rational (a trader can verify them in 30 seconds).
The third is tribal (Bitcoin maximalists amplify for free).

---

## Angles to avoid

| Angle | Why not |
|---|---|
| **Privacy / anonymity** | The trader leaderboard stays public on sprk.fun. If you attack Solana's transparency, it gets turned against you. |
| **Pure decentralization** | Spark = federation. If you call Solana "too centralized," the reply is "what about you?" |
| **Speed / throughput** | Solana has more raw TPS. Not a fight you win. |
| **Fees** | Solana is near-zero. Spark too — not a knockout. |

---

## 3-sentence pitch

> *Pump.fun proved retail memecoins are massive. But Solana has 3
> structural problems traders live with every day: MEV bots
> sandwiching their trades, devs that can rug via mint authority, and
> a chain that halts. sprk.fun is pump.fun on Bitcoin — no MEV, no
> rug, no halt — and your PnL is in sats, not in SOL.*

---

## Twitter-ready one-liners

- *No mint authority. No freeze. No upgrade. Just an asset.*
- *Zero MEV. Zero Jito. Zero sandwich.*
- *The chain doesn't halt. Your bag isn't hostage to a validator gang.*
- *Stack sats, not the token that dumps while you trade.*
- *Pump.fun is a desktop game. sprk.fun is a wallet in your pocket.*
- *Memecoins on Bitcoin. No rug, no MEV, no halt.*
- *On pump.fun you trust the dev. On sprk.fun you don't have to.*
- *Your PnL in sats. Your asset un-ruggable. Your chain doesn't halt. Pick the stack.*
