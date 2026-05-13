# rgb-spark

Reference implementation of **RGB-on-Spark** — RGB v0.11 client-side
validation anchored on Lightspark's Spark L2 leaves instead of Bitcoin
L1 UTXOs, with no payment-channel management and no protocol changes
required on the Spark side.

The construction (**Spark-UTK**, see [`SPARK-UTK.md`](./SPARK-UTK.md))
tweaks the user-side public key with a tagged hash of the RGB Merkle
root *before* FROST aggregation, so the leaf's `verifyingKey` —
and therefore the L1 unilateral-exit output — already carries the
single-use seal. The Spark Service Entity aggregates blindly and never
sees the embedded commitment.

## Status

| Phase | Status |
|---|---|
| **0** — Scoping, prototype, deterministic vectors | ✅ done |
| **1A** — Spark-UTK in `bp-dbc` + `rgb-consensus` | ✅ done |
| **1B** — `rgb-spark-core` WASM wrapper + frontend pipeline | ✅ done |
| **1C / chunk-γ** — Real NIA issuance + transitions over Spark | ✅ done |
| **1C** — Atomic swap orderbook + HTLC settlement (Spark-side, no channel) | ✅ done |
| **1C / clean** — Cross-wallet asset binding (settlement auto-emit + buyer auto-stash + lazy rebind) | ✅ done |

The full RGB-on-Spark loop is mainnet-validated as of 2026-05-13:
issue → bind → trade → atomic settlement → cross-wallet delivery →
re-sell. See [`RGB-ON-SPARK.md`](./RGB-ON-SPARK.md) for what ships
today, product positioning, and the L1 ⇄ Spark bridge design.

The downstream consumer product — **RGB-SPK**, a pure-P2P trading
platform built on these primitives — is scoped in
[`RGB-SPK.md`](./RGB-SPK.md) (separate codebase, future work).

## Layout

```
rgb-spark/
├── SPARK-UTK.md                         ← the RFC (v0.2)
├── README.md                            ← this file
├── CLAUDE.md                            ← agent guidance
├── forks/
│   ├── bp-core/                         ← vendored, modified (Method::SparkUtk = 0x02)
│   ├── rgb-consensus/                   ← vendored, modified (DbcProof::SparkUtk tag 0x03)
│   ├── rgb-spark-core/                  ← our crate: WASM bindings + JS API
│   └── wasm-sniff/                      ← throwaway WASM-compat check
├── scoping/                             ← Phase 0 design notes + repro vectors
├── scripts/build-spark-core.sh          ← Rust → WASM → vendor into frontend/
└── frontend/                            ← React + Vite, the actual wallet
```

## Quickstart

```bash
# Build the WASM bundle (one-time setup: rustup target add wasm32-unknown-unknown ; cargo install wasm-pack ; apt install clang)
bash scripts/build-spark-core.sh

# Run the dev frontend
cd frontend
npm install
npm run dev
```

The frontend imports the vendored WASM directly:

```ts
import init, {
  deriveUTweaked,
  deriveVerifyingKey,
  deriveOutputXonly,
  SparkUtkProofJs,
} from '@/lib/spark-core/rgb_spark_core';
await init();
```

## Trust model

Self-custody, end-to-end. The RGB seal is committed in your own
Spark-leaf `verifyingKey`; the Spark Service holds no secret about
your asset state; the consignment relay (a thin HTTP service)
forwards bytes but never holds funds. Unilateral exit to L1 needs
nothing the user doesn't already have.

This is the opposite end of the trust-spectrum from the **custodial
PPwallet** at [`ppwallet`](https://github.com/LastDegenBtc/ppwallet)
(`wallet.pprgb.app`), which keeps RGB allocations server-side for
interop with the industry RGB ecosystem (Bitmask, rgb-lib). The two
products are intentionally parallel and serve different users.

## Origin

Phase 0 / 1A / 1B engineering was authored in `ppwallet` and
extracted here at SHA `ee3b0fa` on 2026-05-11, once it became clear
the self-custody product needed its own repo, its own roadmap, and
brand-neutral naming (no `pp` prefix) for the RGB-WG conversation.
