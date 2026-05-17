// Lazy rebind on re-sale (Phase 1C/clean session 6).
//
// When a buyer received an asset via the 5.3 inbox auto-stash, their
// rgbStash has the contract + chain bytes, but their Spark leaves are
// vanilla — the Spark-UTK keytweak is single-use, consumed by the
// transfer. To re-sell, the wallet has to FIRST rebind: build T_n+1 on
// top of the latest stash transition, mint a new Spark leaf bound to
// T_n+1.id() via mintViaSelfTransfer, and use that leaf as the asset
// leg of the ask.
//
// This module exposes the detection + rebind logic. It does NOT touch
// the orderbook — the OrderBookPanel calls it before signing/posting
// an ask when a re-sale path is detected.
//
// What "having a live binding" means: a pathTweak entry whose
// `(msg, consumeIndex)` op-output has NOT been consumed by any later
// transition in stash. A binding is *live* iff it points at a transition
// in this asset's chain AND no transition's `inputs` references the
// same (op, no) pair. The "stale" bucket holds entries that have been
// consumed downstream (e.g. the pre-rebind state after a successful
// re-mint, where the new transition consumed the old binding).
//
// Why per-output liveness (not head-only): a wallet that accumulates
// asset across multiple independent trades ends up with N bound leaves,
// each at a different chain position. The older bindings are still
// LIVE — their op-outputs haven't been spent — and their amounts must
// count in the displayed total. The head-only rule (pre-fix) silently
// excluded them and showed 2000 instead of 1000+2000=3000 for two-trade
// buyers. The fix mirrors how rgb-consensus itself decides whether an
// allocation is spendable.

import { ensureSparkCoreReady, sparkCoreIfReady } from './sparkCore';
import { clearPathTweak, listPathTweaks, type PathTweakEntry } from './rgbAwareSigner';
import {
  addTransition,
  getContractById,
  getTransitionByCommitId,
  listTransitionsFor,
  type StashContract,
  type StashTransition,
} from './rgbStash';
import {
  listSparkLeaves,
  mintViaSelfTransfer,
  type SparkLeafRow,
} from './sparkWallet';

function bytesToHex(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface BindingScan {
  contract: StashContract;
  transitions: StashTransition[];
  /** Most-recently-added transition. Null if the asset is still at
   *  genesis. Used by the rebind path to pick the chain head when
   *  building T_{n+1}. */
  latestTransition: StashTransition | null;
  /** Live pathTweak entries — their (msg, consumeIndex) op-output has
   *  NOT been consumed by any later transition in stash. PortfolioView
   *  sums these for the displayed total. In single-trade flows there
   *  is exactly one; multi-trade accumulation produces several until
   *  the next rebind consolidates them via `buildNiaTransitionMerge`. */
  boundEntries: Array<{ currentLeafId: string; entry: PathTweakEntry }>;
  /** Stale pathTweaks for this asset — `msg` matches a known op but
   *  its (op, consumeIndex) has been consumed downstream by a later
   *  transition in stash. Surfaced so a future UI can offer recovery
   *  (sweep the underlying sats) instead of leaving them silently
   *  filtered out. */
  staleEntries: Array<{ currentLeafId: string; entry: PathTweakEntry }>;
}

/**
 * Inspect rgbStash + pathTweaks for the given contractId. Returns null
 * if the contract isn't in stash at all (= we don't know about this
 * asset, can't sell it).
 */
export function scanBinding(contractId: string): BindingScan | null {
  const contract = getContractById(contractId);
  if (!contract) return null;
  const transitions = listTransitionsFor(contractId);
  const latestTransition = transitions.length === 0
    ? null
    : [...transitions].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      )[0];

  // All commitIds for this asset (contract + every transition). A
  // pathTweak whose `msg` isn't in this set belongs to a different
  // asset and is skipped entirely.
  const allCommitIds = new Set<string>();
  allCommitIds.add(contract.contractId.toLowerCase());
  for (const t of transitions) allCommitIds.add(t.commitId.toLowerCase());

  // Walk every transition's inputs to build the set of consumed
  // (op, no) op-outputs. A pathTweak entry pointing at any of these is
  // stale; anything else is live. niaTransitionInputs returns a flat
  // [op0, no0, op1, no1, …] array — chunk by 2.
  //
  // If WASM isn't loaded yet (race during boot, before any of the
  // settlement/rebind paths have triggered init), `consumedOpouts`
  // stays empty and every pathTweak whose msg matches the asset is
  // bucketed as bound. This over-counts in the degenerate case (a
  // genuinely-spent binding would show as live until the next render
  // after WASM init), but is the safe direction: the alternative
  // (declaring everything stale until we can prove otherwise) silently
  // hides live allocations.
  const consumedOpouts = new Set<string>();
  const core = sparkCoreIfReady();
  if (core) {
    for (const t of transitions) {
      const flat = core.niaTransitionInputs(t.transitionHex);
      for (let i = 0; i + 1 < flat.length; i += 2) {
        consumedOpouts.add(`${flat[i].toLowerCase()}|${flat[i + 1]}`);
      }
    }
  }

  const all = listPathTweaks();
  const boundEntries: BindingScan['boundEntries'] = [];
  const staleEntries: BindingScan['staleEntries'] = [];
  for (const t of all) {
    const msgHex = bytesToHex(t.msg).toLowerCase();
    if (!allCommitIds.has(msgHex)) continue;
    const { currentLeafId, ...rest } = t;
    const consumed = consumedOpouts.has(`${msgHex}|${rest.consumeIndex}`);
    if (consumed) {
      staleEntries.push({ currentLeafId, entry: rest });
    } else {
      boundEntries.push({ currentLeafId, entry: rest });
    }
  }
  return { contract, transitions, latestTransition, boundEntries, staleEntries };
}

/**
 * Pick the leaf in the wallet that's currently bound to this asset
 * (via pathTweaks). Returns the SparkLeafRow so the caller has both
 * the leaf id AND the operator/verifyingKey it'll need for the
 * settlement auto-emit later. If multiple bound leaves exist, picks
 * the first match — v0 has no split/merge so they all carry the same
 * RGB amount.
 */
export async function findBoundLeaf(contractId: string): Promise<SparkLeafRow | null> {
  const scan = scanBinding(contractId);
  if (!scan || scan.boundEntries.length === 0) return null;
  const leaves = await listSparkLeaves();
  for (const b of scan.boundEntries) {
    const leaf = leaves.find((l) => l.id === b.currentLeafId);
    if (leaf) return leaf;
  }
  return null;
}

export type RebindOutcome =
  | { status: 'already-bound'; leafId: string }
  | { status: 'rebound'; newLeafId: string; newCommitIdHex: string }
  | { status: 'no-stash'; reason: string }
  | { status: 'no-source-leaf'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Make sure the wallet holds a single leaf carrying the SUM of all live
 * allocations for this asset, bound to a fresh chain head. Idempotent —
 * a wallet already in that state is a no-op (`already-bound`). Otherwise
 * the function consolidates every live binding into one new leaf:
 *
 *   1. Collect merge sources = every live pathTweak entry's (transition,
 *      consumeIndex, amount) + the buyer's fresh allocation at
 *      latestTransition[0] if no pathTweak references it yet.
 *   2. Build T_{n+1}:
 *      - Zero sources (genesis-only asset, no transitions): consume the
 *        full supply from the genesis via `buildNiaTransition`.
 *      - One source: `buildNiaTransitionFromPrev` (single-input).
 *      - Multiple sources: `buildNiaTransitionMerge` (multi-input
 *        merge into a single-output equal to the sum).
 *   3. Pick a vanilla source leaf (smallest, leaves earmarked for HTLC
 *      sats unaffected), mint via `mintViaSelfTransfer`.
 *   4. Persist T_{n+1} in stash and clear pathTweak entries for the
 *      now-consumed source bindings — their op-outputs are spent so
 *      the old leaves no longer represent live RGB allocations.
 *
 * Returns a structured outcome so the caller can render status without
 * exception-driven control flow.
 */
export interface LazyRebindOptions {
  /** F2 trustless gate: pin the self-transfer source to the specific
   *  Spark leaf the buyer just received via HTLC (identified by
   *  verifyingPublicKey match in the settlement inbox). The rebind
   *  carries that leaf's u_base into the new bound leaf, so the
   *  Spark-UTK chain across the trade traces back to actual ownership.
   *  Without this override the picker falls back to "smallest vanilla
   *  leaf", which lets a non-paying buyer fake binding to any leaf —
   *  the bug surfaced 2026-05-17. */
  sourceLeafIdOverride?: string;
}

export async function lazyRebindIfNeeded(
  contractId: string,
  opts?: LazyRebindOptions,
): Promise<RebindOutcome> {
  try {
    const scan = scanBinding(contractId);
    if (!scan) {
      return {
        status: 'no-stash',
        reason: `contract ${contractId.slice(0, 12)}… not in rgbStash — can't re-sell what we haven't received`,
      };
    }

    const headCommit = scan.latestTransition?.commitId.toLowerCase();
    const headEntry = scan.boundEntries.find(
      (e) => bytesToHex(e.entry.msg).toLowerCase() === headCommit,
    );

    // Already-perfect state: exactly one live binding, and it points at
    // the current chain head. Nothing to consolidate.
    if (scan.boundEntries.length === 1 && headEntry) {
      return { status: 'already-bound', leafId: headEntry.currentLeafId };
    }

    // Build the list of (prev_transition_hex, consumeIndex, amount)
    // triples we want to fold into the new merged leaf. Two source
    // kinds:
    //   - every live pathTweak entry whose msg references a known stash
    //     transition (we have the bytes to feed into the validator);
    //   - the buyer's fresh allocation at scan.latestTransition[0] iff
    //     no pathTweak entry has been minted for it yet.
    interface MergeSource {
      transitionHex: string;
      consumeIndex: number;
      amount: bigint;
      /** Leaf id of the existing binding being consumed (for pathTweak
       *  cleanup). undefined for the fresh-head case. */
      consumedLeafId?: string;
    }
    const mergeSources: MergeSource[] = [];
    for (const e of scan.boundEntries) {
      const msgHex = bytesToHex(e.entry.msg).toLowerCase();
      const prev = getTransitionByCommitId(msgHex);
      if (!prev) {
        // Genesis-bound entry (msg == contractId, no transition layer).
        // We don't merge across the genesis boundary in v0 — the rare
        // issuer flow keeps its existing single-input path below.
        continue;
      }
      mergeSources.push({
        transitionHex: prev.transitionHex,
        consumeIndex: e.entry.consumeIndex,
        amount: e.entry.amount,
        consumedLeafId: e.currentLeafId,
      });
    }
    // Fresh-arrival input: latestTransition has a buyer allocation that
    // hasn't been minted yet. Convention: output 0 is the recipient slot
    // (session 7.3 split-merge). Skip if a pathTweak entry already
    // points there.
    if (scan.latestTransition && !headEntry) {
      const targetOutput = scan.latestTransition.outputs[0];
      if (!targetOutput) {
        return {
          status: 'failed',
          reason: `latest transition for ${contractId.slice(0, 12)}… has no outputs[0] entry`,
        };
      }
      mergeSources.push({
        transitionHex: scan.latestTransition.transitionHex,
        consumeIndex: 0,
        amount: BigInt(targetOutput.amount),
      });
    }

    const core = await ensureSparkCoreReady();
    const dummyTxid = '00'.repeat(32);
    const genesisHex = scan.contract.consignmentHex;

    let amount: bigint;
    let newCommitIdHex: string;
    let newTransitionHex: string;

    if (mergeSources.length === 0) {
      // No transitions / no live allocations to consume. Either the
      // asset is genesis-only in our stash (rare — the issuer flow
      // hasn't built any transition yet) or every binding is already
      // stale. Use the genesis as the input.
      amount = BigInt(scan.contract.supply);
      const t = core.buildNiaTransition(genesisHex, 0, amount, dummyTxid, 0);
      try {
        newCommitIdHex = t.commitIdHex;
        newTransitionHex = t.transitionHex;
      } finally {
        t.free();
      }
    } else if (mergeSources.length === 1) {
      // Single-input path. Cheaper bytes than a merge and equivalent
      // semantically when there's only one source.
      const s = mergeSources[0];
      amount = s.amount;
      const t = core.buildNiaTransitionFromPrev(
        s.transitionHex,
        genesisHex,
        s.consumeIndex,
        s.amount,
        dummyTxid,
        0,
      );
      try {
        newCommitIdHex = t.commitIdHex;
        newTransitionHex = t.transitionHex;
      } finally {
        t.free();
      }
    } else {
      // Multi-input merge: fuses all live allocations into one output
      // equal to their sum. The schema validator enforces conservation
      // independently via AluVM; we mirror it client-side for fail-fast
      // on accounting bugs.
      amount = mergeSources.reduce((acc, s) => acc + s.amount, 0n);
      const indices = new Uint32Array(mergeSources.map((s) => s.consumeIndex));
      const prevHexes = mergeSources.map((s) => s.transitionHex);
      const amountsDec = mergeSources.map((s) => s.amount.toString());
      const t = core.buildNiaTransitionMerge(
        genesisHex,
        prevHexes,
        indices,
        amountsDec,
        dummyTxid,
        0,
      );
      try {
        newCommitIdHex = t.commitIdHex;
        newTransitionHex = t.transitionHex;
      } finally {
        t.free();
      }
    }

    // Source leaf for the self-transfer. The trustless path is to
    // CARRY OVER the leaf actually received from the seller via HTLC —
    // the inbox passes its id as `sourceLeafIdOverride`. Falling back
    // to "any vanilla leaf" lets non-paying buyers fake binding (the
    // 2026-05-17 atomicity hole); the override is the load-bearing fix.
    const leaves = await listSparkLeaves();
    if (leaves.length === 0) {
      return {
        status: 'no-source-leaf',
        reason: 'wallet has no Spark leaves to act as transfer carrier — fund first',
      };
    }
    let sourceLeaf: SparkLeafRow;
    if (opts?.sourceLeafIdOverride) {
      const found = leaves.find((l) => l.id === opts.sourceLeafIdOverride);
      if (!found) {
        return {
          status: 'no-source-leaf',
          reason:
            `sourceLeafIdOverride=${opts.sourceLeafIdOverride.slice(0, 12)}… not present in ` +
            `current leaves — claimed leaf went missing between inbox accept and rebind. ` +
            `Refusing to fall back to a random vanilla leaf (atomicity gate).`,
        };
      }
      sourceLeaf = found;
    } else {
      // Legacy path: smallest vanilla leaf. Used only by direct UI
      // triggers (PortfolioView Claim button when manually called),
      // NOT by the settlement inbox post-F2.
      const all = listPathTweaks();
      const boundLeafIds = new Set(all.map((t) => t.currentLeafId));
      const vanillaLeaves = leaves.filter((l) => !boundLeafIds.has(l.id));
      if (vanillaLeaves.length === 0) {
        return {
          status: 'no-source-leaf',
          reason: 'every leaf in the wallet is already bound — nothing left to use as a vanilla carrier',
        };
      }
      sourceLeaf = vanillaLeaves.reduce(
        (min, l) => (l.value < min.value ? l : min),
      );
    }

    const msgBytes = hexToBytes(newCommitIdHex);
    // v0 rebind uses single-output T_n+1, so consumeIndex is always 0.
    // Multi-output rebind (split-merge UX path) lands in a later session.
    const result = await mintViaSelfTransfer(sourceLeaf.id, msgBytes, amount, 0, {
      transitionHex: newTransitionHex,
      prevGenesisHex: genesisHex,
    });

    // Persist T_n+1 in stash so subsequent scanBinding calls recognise
    // the new pathTweak entry's msg (= T_n+1.id()) as belonging to this
    // contract. Without this, the freshly-bound leaf shows up as
    // "unbound" in any UI that walks stash transitions (notably the
    // sprk.fun PortfolioView). addTransition is idempotent on commitId,
    // so re-running the rebind path is safe.
    addTransition({
      commitId: newCommitIdHex.toLowerCase(),
      prevContractId: scan.contract.contractId,
      outputs: [{ amount: amount.toString() }],
      transitionHex: newTransitionHex,
      createdAt: new Date().toISOString(),
    });

    // After a multi-input merge, the source pathTweak entries point at
    // op-outputs that T_{n+1} just consumed — their leaves no longer
    // carry live RGB. Clear them so the wallet doesn't try to re-spend
    // a stale binding. (Single-input case: the prior entry, if any, is
    // for a transition the merge didn't touch — leave it alone.)
    if (mergeSources.length > 1) {
      for (const s of mergeSources) {
        if (s.consumedLeafId) clearPathTweak(s.consumedLeafId);
      }
    }

    return {
      status: 'rebound',
      newLeafId: result.leaf.id,
      newCommitIdHex,
    };
  } catch (e) {
    return {
      status: 'failed',
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
