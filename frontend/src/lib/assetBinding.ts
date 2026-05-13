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
// What "having a live binding" means: a pathTweak entry exists whose
// `msg` matches either the contractId itself OR any transition's
// commitId for that contract. We don't try to enforce "the latest"
// here — the place() flow can resell against an older bound leaf if
// the user explicitly picks one, and a future split/merge layer will
// need a different model anyway.

import { ensureSparkCoreReady } from './sparkCore';
import { listPathTweaks, type PathTweakEntry } from './rgbAwareSigner';
import {
  addTransition,
  getContractById,
  listTransitionsFor,
  type StashContract,
  type StashTransition,
} from './rgbStash';
import {
  ensureLeafOfExactSize,
  listSparkLeaves,
  mintViaSelfTransfer,
  SPARK_DUST_THRESHOLD,
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

/**
 * Set of 32-byte commit ids for an asset: the contractId itself plus
 * every known transition's commitId. A pathTweak whose `msg` is in this
 * set is bound to this asset.
 */
function bindingCommitIds(contract: StashContract, transitions: StashTransition[]): Set<string> {
  const ids = new Set<string>();
  ids.add(contract.contractId.toLowerCase());
  for (const t of transitions) ids.add(t.commitId.toLowerCase());
  return ids;
}

export interface BindingScan {
  contract: StashContract;
  transitions: StashTransition[];
  /** Most-recently-added transition. Heuristic for "chain head" in the
   *  v0 linear-chain world. Null if the asset is still at genesis. */
  latestTransition: StashTransition | null;
  /** PathTweak entries whose msg is bindable to this asset. Multiple
   *  entries can coexist if the user minted several leaves over time. */
  boundEntries: Array<{ currentLeafId: string; entry: PathTweakEntry }>;
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
  const commitIds = bindingCommitIds(contract, transitions);
  const all = listPathTweaks();
  const boundEntries = all
    .filter((t) => commitIds.has(bytesToHex(t.msg).toLowerCase()))
    .map(({ currentLeafId, ...rest }) => ({ currentLeafId, entry: rest }));
  return { contract, transitions, latestTransition, boundEntries };
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
 * Make sure the wallet holds a leaf bound to the asset. If a binding
 * already exists this is a no-op. Otherwise:
 *
 *   1. Build T_n+1 over the latest known transition (or the genesis if
 *      no transitions in stash yet) via `buildNiaTransitionFromPrev` /
 *      `buildNiaTransition`. Allocates the full prior amount — no
 *      split/merge.
 *   2. Pick any vanilla source leaf from the wallet (smallest by
 *      sats, so we don't disturb a leaf earmarked as a buyer-side
 *      sats lock for a different open order).
 *   3. Call `mintViaSelfTransfer(sourceLeaf.id, T_n+1.id() bytes,
 *      {transitionHex, prevGenesisHex})`. The new destination leaf is
 *      registered in pathTweaks; the wallet now has a live binding.
 *
 * Returns a structured outcome so the caller can render status without
 * exception-driven control flow.
 */
export async function lazyRebindIfNeeded(contractId: string): Promise<RebindOutcome> {
  try {
    const scan = scanBinding(contractId);
    if (!scan) {
      return {
        status: 'no-stash',
        reason: `contract ${contractId.slice(0, 12)}… not in rgbStash — can't re-sell what we haven't received`,
      };
    }
    if (scan.boundEntries.length > 0) {
      return { status: 'already-bound', leafId: scan.boundEntries[0].currentLeafId };
    }

    const core = await ensureSparkCoreReady();
    const dummyTxid = '00'.repeat(32);

    // Build the next link in the chain. Two cases by whether the asset
    // is still at genesis (we just minted it ourselves and haven't done
    // anything yet — uncommon for the re-sale path, but valid) or has a
    // prior transition (the standard re-sale case).
    const genesisHex = scan.contract.consignmentHex;
    // For the genesis-only path, the full supply is the only valid
    // input. For the transition path, the wallet's allocation lives at
    // output 0 by convention (session 7.3: T_new[0] = recipient,
    // T_new[1] = sender-as-change). Using contract.supply here was a
    // bug — partial-fill buyers got T_new[0] < supply and the conserv-
    // ation check in build_nia_transition_from_prev rejected the rebind
    // with "amount != prev allocation".
    let amount: bigint;
    let newCommitIdHex: string;
    let newTransitionHex: string;
    if (scan.latestTransition) {
      const targetOutput = scan.latestTransition.outputs[0];
      if (!targetOutput) {
        return {
          status: 'failed',
          reason: `latest transition for ${contractId.slice(0, 12)}… has no outputs[0] entry`,
        };
      }
      amount = BigInt(targetOutput.amount);
      const t = core.buildNiaTransitionFromPrev(
        scan.latestTransition.transitionHex,
        genesisHex,
        0,
        amount,
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
      amount = BigInt(scan.contract.supply);
      const t = core.buildNiaTransition(genesisHex, 0, amount, dummyTxid, 0);
      try {
        newCommitIdHex = t.commitIdHex;
        newTransitionHex = t.transitionHex;
      } finally {
        t.free();
      }
    }

    // Source leaf for the self-transfer. sprk.11: keep the source
    // dust-sized so the resulting bound asset leaf doesn't carry
    // excess sats — those sats would leak as overpay at HTLC swap
    // time. ensureLeafOfExactSize splits via transferToSpark when
    // needed; the SDK coin-selects across multiple small leaves.
    const leaves = await listSparkLeaves();
    if (leaves.length === 0) {
      return {
        status: 'no-source-leaf',
        reason: 'wallet has no Spark leaves to act as transfer carrier — fund first',
      };
    }
    // Exclude leaves that ALREADY carry a binding — those are someone
    // else's bound asset (or a stale binding for this same asset that
    // would be lost by the transfer).
    const all = listPathTweaks();
    const boundLeafIds = new Set(all.map((t) => t.currentLeafId));
    const vanillaLeaves = leaves.filter((l) => !boundLeafIds.has(l.id));
    if (vanillaLeaves.length === 0) {
      return {
        status: 'no-source-leaf',
        reason: 'every leaf in the wallet is already bound — nothing left to use as a vanilla carrier',
      };
    }
    // Fast path: a dust-sized vanilla leaf already exists.
    const dustVanilla = vanillaLeaves.find((l) => l.value === SPARK_DUST_THRESHOLD);
    let sourceLeaf: SparkLeafRow;
    if (dustVanilla) {
      sourceLeaf = dustVanilla;
    } else {
      try {
        sourceLeaf = await ensureLeafOfExactSize(SPARK_DUST_THRESHOLD);
      } catch (e) {
        return {
          status: 'no-source-leaf',
          reason: `couldn't prepare a dust-sized source leaf: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
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
