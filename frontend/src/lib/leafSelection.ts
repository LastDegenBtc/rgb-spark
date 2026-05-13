// Buyer-side leaf selection planner for HTLC sats lock.
//
// Spark HTLC primitives (`lockUnderHash`) lock whole leaves, not split
// amounts. The buyer must therefore pick a subset of their existing
// vanilla leaves whose total equals the agreed priceSats — otherwise
// the seller is overpaid by the difference at preimage reveal time.
//
// Power-of-2 leaf reality: deposits produce power-of-2 leaves (1024,
// 256, 64, …) and the SE swap that would otherwise split into an
// arbitrary value didn't reliably trigger on our mainnet probe (see
// [[reference-spark-leaf-denominations]] in agent memory). So exact-
// sum is achievable only when the available leaf bag contains a
// subset summing to target.
//
// This module exports `planSatsLock` which returns one of:
//   - { mode: 'exact', leaves, lockSats=target, overpay=0 }
//   - { mode: 'overpay', leaves, lockSats, overpay }  — smallest
//     covering subset; the caller surfaces the overpay to the user
//     for explicit consent.
//   - { mode: 'insufficient', leaves: [], totalAvailable }  — not
//     even the sum of all leaves covers the target.
//
// Subset-sum is NP-hard in general; here N is small (typically <30
// vanilla leaves), and the target is bounded (priceSats ≪ 2^32), so
// a depth-first backtracking with descending-leaf ordering terminates
// in microseconds for realistic inputs.

/** Minimal leaf shape — we don't depend on the SDK's TreeNode here. */
export interface LeafCandidate {
  id: string;
  value: number;
}

export type SatsLockPlan<L extends LeafCandidate> =
  | { mode: 'exact'; leaves: L[]; lockSats: number; overpay: 0 }
  | { mode: 'overpay'; leaves: L[]; lockSats: number; overpay: number }
  | { mode: 'insufficient'; leaves: []; totalAvailable: number };

/**
 * Pick leaves to lock for an HTLC payment of exactly `target` sats.
 * Returns a plan; the caller decides whether to proceed (exact-pay
 * mode is silent, overpay mode should require user consent).
 *
 * Algorithm:
 *   1. Sum of all leaves < target → insufficient.
 *   2. Backtracking DFS sorted descending tries to find a subset
 *      summing exactly to target. Pruning: skip leaves > remaining,
 *      bail when current path can't reach remaining even with all
 *      following leaves. Empirically <1 ms on 30-leaf bags.
 *   3. If no exact subset, return the smallest single covering leaf
 *      (= smallest leaf ≥ target). This is the v0 overpay fallback;
 *      a future revision might fall back to a multi-leaf subset that
 *      OVER-shoots target by the minimum amount, but for power-of-2
 *      bags single-leaf is usually within a factor of 2 anyway.
 */
export function planSatsLock<L extends LeafCandidate>(
  leaves: L[],
  target: number,
): SatsLockPlan<L> {
  if (!Number.isSafeInteger(target) || target <= 0) {
    throw new Error(`planSatsLock target must be a positive safe integer, got ${target}`);
  }
  const total = leaves.reduce((acc, l) => acc + l.value, 0);
  if (total < target) {
    return { mode: 'insufficient', leaves: [], totalAvailable: total };
  }

  const sorted = [...leaves].sort((a, b) => b.value - a.value);

  // Precompute suffix sums for pruning: at depth i, if sum_so_far +
  // suffixSum[i] < target, no completion is possible.
  const suffixSum = new Array<number>(sorted.length + 1).fill(0);
  for (let i = sorted.length - 1; i >= 0; i--) {
    suffixSum[i] = suffixSum[i + 1] + sorted[i].value;
  }

  const path: L[] = [];
  let solution: L[] | null = null;

  function dfs(idx: number, remaining: number): boolean {
    if (remaining === 0) {
      solution = path.slice();
      return true;
    }
    if (idx >= sorted.length) return false;
    if (suffixSum[idx] < remaining) return false; // can't reach target

    const leaf = sorted[idx];
    // Include if it fits.
    if (leaf.value <= remaining) {
      path.push(leaf);
      if (dfs(idx + 1, remaining - leaf.value)) return true;
      path.pop();
    }
    // Skip.
    return dfs(idx + 1, remaining);
  }
  dfs(0, target);

  if (solution !== null) {
    return { mode: 'exact', leaves: solution, lockSats: target, overpay: 0 };
  }

  // Overpay fallback: smallest single leaf ≥ target.
  const covering = sorted
    .filter((l) => l.value >= target)
    .sort((a, b) => a.value - b.value);
  if (covering.length > 0) {
    const leaf = covering[0];
    return {
      mode: 'overpay',
      leaves: [leaf],
      lockSats: leaf.value,
      overpay: leaf.value - target,
    };
  }

  // No single leaf covers, but total does. Greedy descending sum to
  // produce a multi-leaf overpay: smallest count of leaves whose sum
  // is ≥ target. Same overpay semantics — buyer gives more than
  // priceSats, seller claims it all on preimage reveal.
  const greedy: L[] = [];
  let acc = 0;
  for (const leaf of sorted) {
    greedy.push(leaf);
    acc += leaf.value;
    if (acc >= target) break;
  }
  return {
    mode: 'overpay',
    leaves: greedy,
    lockSats: acc,
    overpay: acc - target,
  };
}
