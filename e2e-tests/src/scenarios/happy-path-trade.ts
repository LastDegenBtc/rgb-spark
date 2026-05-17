// scenario:happy-path-trade — SKELETON.
//
// Full alice-sells-to-bob trade against mainnet Spark + a running
// relay. Currently a placeholder that announces the work-to-do so
// `npm run scenario:happy-path-trade` returns a structured "not yet
// implemented" rather than a runtime error.
//
// The real implementation (next commit) walks:
//   1. Derive alice + bob sub-wallets from funding master.
//   2. Fund both via Spark→Spark from funding (smoke covers this).
//   3. alice mints a fresh NIA asset (via WASM `issueNiaContract`).
//   4. alice places an ask for N units at M sats via placeAsk.
//   5. bob places a matching bid via signed POST /order.
//   6. Both flows run in parallel: alice = runSellerFlow + auto-emit,
//      bob = runBuyerFlow + settlement inbox + lazyRebindIfNeeded.
//   7. Post-conditions:
//      - alice.balance went UP by M sats (modulo asset-leaf return).
//      - bob.balance went DOWN by M sats.
//      - alice.scanBinding shows remaining = supply - N.
//      - bob.scanBinding shows N units bound, sourceLeafId is the
//        leaf received from alice via HTLC (F2 trustless gate held).
//      - Both wallets see the trade in listSparkTransfers with
//        status=COMPLETED, type=PREIMAGE_SWAP.

import type { ScenarioContext, ScenarioResult } from '../cli/run-scenario.ts'

export default async function happyPathTrade(_ctx: ScenarioContext): Promise<ScenarioResult> {
  return {
    passed: false,
    steps: [
      {
        name: 'happy-path-trade implementation',
        ok: false,
        detail: 'skeleton only — run `npm run scenario:smoke` first to validate harness primitives',
      },
    ],
    summary: 'not yet implemented; smoke scenario must pass before this one is wired',
  }
}
