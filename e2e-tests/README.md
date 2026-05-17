# rgb-spark-e2e

End-to-end test harness for the rgb-spark libs against mainnet Spark
+ the local consignment relay.

## Why this exists

The frontend lib (`../frontend/src/lib/`) wraps two heavy primitives —
the Spark SDK (HTLC swaps, key tweaks) and the relay (orderbook,
consignments, registry). Driving them by hand from the browser is
slow and error-prone. This package boots N controlled wallets in
Node, drives them through end-to-end trade scenarios, and asserts
post-conditions, all from a single command.

Tests run against REAL mainnet Spark. Every scenario costs sats
(typically 2–10 per trade for the carrier leaf + SE fees). Fund the
master wallet once with ~5000 sats and you have ~500 test runs of
budget.

## First-run setup

```sh
cd rgb-spark/e2e-tests
npm install
npm run setup
```

`setup` generates a fresh 32-byte seed (persisted to `.env`,
gitignored), boots the funding wallet, and prints both the Spark
address and L1 deposit address. Send sats either way:

- Spark→Spark (instant, recommended): transfer to the Spark address.
- L1 BTC (needs 6 confs): send to the L1 deposit address, then
  `npm run claim -- <txid>` once it confirms.

Verify funded:

```sh
npm run info
```

## Running scenarios

Scenarios live in `src/scenarios/`. Each one:
1. Derives per-test wallets from the funding master via HMAC-SHA256.
2. Funds them via Spark→Spark transfer from the master.
3. Drives the rgb-spark libs through a specific flow.
4. Asserts on observable post-conditions (balances, RGB stash, etc).

CLI:

```sh
npm run scenario:happy        # alice mints, bob buys, HTLC settles
```

The scenario runner prints structured progress + final pass/fail.

## Layout

```
src/
├── cli/                   # npm-run entrypoints
│   ├── setup.ts           # init + print funding addresses
│   ├── info.ts            # status report
│   ├── claim-deposits.ts  # claim L1 deposits
│   └── run-scenario.ts    # dispatch to src/scenarios/<name>.ts
├── lib/
│   ├── storage-polyfill.ts # Node-side localStorage shim
│   ├── derive-seed.ts      # HMAC sub-seed derivation
│   └── test-wallet.ts      # SparkWallet + nostr identity factory
├── scenarios/
│   └── happy-path-trade.ts
└── env.ts                  # .env loader / writer
```

## Constraints

- The `frontend/src/lib/sparkWallet.ts` wrapper is a singleton; the
  harness bypasses it and calls `SparkWallet.initialize` directly
  per TestWallet so N wallets coexist in one Node process.
- `localStorage`-backed stores (pathTweakStorage, rgbStash, etc.) get
  a per-wallet in-memory backing via `installStorage()` between test
  setups.
- `EventSource` (SSE) is not polyfilled — scenarios poll the orderbook
  REST endpoints instead, which matches the relay's own reconcile
  posture.
