// Settlement-coupled consignment auto-emit (Phase 1C/clean session 5.2).
//
// At the end of a seller-side HTLC swap, the buyer receives a vanilla
// Spark leaf. The RGB asset state that was bound (via Spark-UTK) to the
// seller's pre-swap leaf does NOT travel with the leaf — the keytweak is
// single-use and consumed by transfer. To close the cross-wallet asset-
// binding loop honestly, we ship the next-link transition over the
// consignment relay so the buyer can validate the chain and persist
// `genesis → … → T_new` in their rgbStash. The buyer's leaf remains
// vanilla at this stage; the binding evidence lives in the stash.
//
// Trust model:
//   - The envelope is BIP-340-signed by the seller's nsec — same nsec
//     that committed the matched ask in the orderbook + completed the
//     HTLC settlement, so any tampering is detectable.
//   - The transition+chain is validated client-side by the buyer via
//     `core.validateNiaTransition(FromPrev)` — schema rules enforce
//     conservation locally, no L1 witness.
//   - The relay is a transport, never custody.
//
// This module exposes two functions:
//   - `captureSettlementSnapshot(leafId)`: queries the wallet for the
//     leaf's operator/verifyingPublicKey + recovers the RGB payload from
//     pathTweaks + looks up the stash contract for amount. Must be called
//     while the leaf is STILL in the wallet (pre-swap, OR for probe
//     usage where the leaf hasn't been sold).
//   - `runAutoEmit(ctx)`: builds T_new on top of the snapshot, composes
//     and signs an envelope v4, POSTs to /consignment/:buyerNpub.

import { ensureSparkCoreReady } from './sparkCore';
import { clearPathTweak, getPathTweak, listPathTweaks } from './rgbAwareSigner';
import { listSparkLeaves, mintViaSelfTransfer } from './sparkWallet';
import { postConsignment } from './consignmentRelay';
import { addTransition } from './rgbStash';
import { signEnvelope, type UnsignedEnvelopeV4 } from './envelopeSign';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

export interface SettlementSnapshot {
  /** Leaf id whose pathTweak binding we'll forward. */
  lockedLeafId: string;
  /** From the SparkLeafRow: needed for the proof composition. */
  operatorPublicKeyHex: string;
  /** From the SparkLeafRow: included in leafReference for cross-check. */
  verifyingPublicKeyHex: string;
  /** From the pathTweak entry: the seller's pre-tweak base pubkey. */
  uBaseHex: string;
  /** From the SparkLeafRow. */
  treeId: string;
  value: number;
  network: string;
  /** Hex-encoded copy of pathTweak.msg (= T_n.id() for transition-bound
   *  leaves, or contractId for genesis-bound). */
  msgHex: string;
  /** Source of the chain root — always the strict-encoded genesis
   *  consignment (hex), recovered from pathTweak. For depth-1 leaves
   *  this is the entry's consignmentHex; for depth-2 leaves it's
   *  entry.prevGenesisHex. */
  genesisHex: string;
  /** Set only when the bound leaf is depth-2 (entry.transitionHex is
   *  defined): the T_1 bytes that consumed genesis. Drives the choice
   *  between buildNiaTransition (no prev_transition) and
   *  buildNiaTransitionFromPrev (with prev_transition). */
  prevTransitionHex?: string;
  /** The total amount the bound leaf represents (= pathTweak.amount).
   *  When the order amount < this value, T_new is built as a multi-output
   *  split (Phase 1C/clean session 7.3) — buyer's share + seller's change. */
  amount: bigint;
  /** Output index within `msg`'s transition that this leaf maps to.
   *  Passed as `consume_index` to buildNiaTransition* when building
   *  T_new. Always 0 today; non-zero for change leaves minted from
   *  multi-output transitions. */
  consumeIndex: number;
  /** Recovered from the genesis consignment via validateNiaConsignment. */
  contractId: string;
  /** Convenience flag derived from prevTransitionHex presence. */
  payloadKind: 'transition' | 'genesis';
}

export type SnapshotResult =
  | { ok: true; snapshot: SettlementSnapshot }
  | { ok: false; reason: string };

/**
 * Capture all the data needed for an auto-emit from a leaf that's still
 * in the wallet. Returns a structured Result rather than throwing — the
 * caller (probe UI, or future OrderRow pre-swap snapshot) wants to render
 * the reason on failure, not have an exception unwind through render.
 */
export async function captureSettlementSnapshot(
  lockedLeafId: string,
): Promise<SnapshotResult> {
  const entry = getPathTweak(lockedLeafId);
  if (!entry) {
    return { ok: false, reason: `no pathTweak entry for leaf ${lockedLeafId.slice(0, 12)}…` };
  }
  if (!entry.transitionHex && !entry.consignmentHex) {
    return { ok: false, reason: 'pathTweak entry has no RGB payload — leaf was bound to a foreign msg' };
  }

  let leaves;
  try {
    leaves = await listSparkLeaves();
  } catch (e) {
    return { ok: false, reason: `listSparkLeaves failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const leaf = leaves.find((l) => l.id === lockedLeafId);
  if (!leaf) {
    return {
      ok: false,
      reason:
        `leaf ${lockedLeafId.slice(0, 12)}… not present in current wallet leaves — ` +
        'snapshot requires the leaf still be in wallet (capture before swap, or use a leaf that ' +
        'has not been sold yet).',
    };
  }

  const core = await ensureSparkCoreReady();
  const genesisHex = entry.transitionHex ? entry.prevGenesisHex! : entry.consignmentHex!;
  // Re-validate the genesis client-side to recover the canonical
  // contractId — trustless, even if the local stash was wiped or never
  // had this contract.
  let contractId: string;
  try {
    const meta = core.niaGenesisMetadata(genesisHex);
    try {
      contractId = meta.contractId;
    } finally {
      meta.free();
    }
  } catch (e) {
    return {
      ok: false,
      reason: `niaGenesisMetadata failed on pathTweak genesis: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    snapshot: {
      lockedLeafId,
      operatorPublicKeyHex: leaf.operatorPublicKey,
      verifyingPublicKeyHex: leaf.verifyingPublicKey,
      uBaseHex: bytesToHex(entry.uBase),
      treeId: leaf.treeId,
      value: leaf.value,
      network: leaf.network,
      msgHex: bytesToHex(entry.msg),
      genesisHex,
      prevTransitionHex: entry.transitionHex,
      // Phase 1C/clean session 7.3: the leaf's holding lives on the
      // pathTweak entry now (was: contract.supply from rgbStash, which
      // was correct only when the leaf carried the full supply).
      amount: entry.amount,
      consumeIndex: entry.consumeIndex,
      contractId,
      payloadKind: entry.transitionHex ? 'transition' : 'genesis',
    },
  };
}

export interface AutoEmitContext {
  snapshot: SettlementSnapshot;
  myNpub: string;
  myNostrPrivkeyHex: string;
  mySparkIdentityPubkey: string;
  buyerNpub: string;
  /** Phase 1C/clean session 7.3: amount of the asset being transferred
   *  to the buyer. If equal to `snapshot.amount`, T_new has a single
   *  output (full transfer — current behavior pre-7.3). If strictly
   *  less, T_new is a 2-output split: outputs[0] is the buyer's share
   *  (orderAmount), outputs[1] is the seller's change
   *  (snapshot.amount − orderAmount). Must be > 0 and ≤ snapshot.amount. */
  orderAmount: bigint;
}

export type AutoEmitOutcome =
  | {
      status: 'emitted';
      envelopeId: string;
      bytesPosted: number;
      newCommitIdHex: string;
      newTransitionHex: string;
      payloadKind: 'transition' | 'genesis';
      /** Number of outputs in T_new. 1 = full transfer, 2 = split. */
      outputCount: number;
      /** Output index the buyer's share is at (always 0 in v0). */
      buyerOutputIndex: number;
      /** Change amount that went back to the seller as T_new[outputCount-1].
       *  Zero when full transfer. */
      changeAmount: bigint;
      /** New Spark leaf the seller minted bound to T_new's change output.
       *  Set only on partial fills (changeAmount > 0). Phase 1C/clean
       *  session 7.3b. */
      changeLeafId?: string;
      /** Non-fatal post-emit warning (e.g. change-leaf mint failed but
       *  the envelope is still queued at the relay). Lets the UI render
       *  partial success. */
      postEmitWarning?: string;
    }
  | { status: 'failed'; reason: string };

/**
 * Build T_new on top of the snapshot, compose & sign an envelope v4, POST
 * to the buyer's relay queue. Pure async — no throws on expected failure
 * paths, just `{status: 'failed'}` with a reason.
 *
 * Single-output vs multi-output dispatch is driven by `ctx.orderAmount`
 * vs `ctx.snapshot.amount`. Equal → 1-output, less → 2-output split.
 * Greater → rejected.
 *
 * The seller's change leaf is NOT minted here (deferred to session 7.3b).
 * After a split emit, the caller is responsible for either (a) letting
 * the seller manually rebind via `lazyRebindIfNeeded` later or (b)
 * minting the change leaf directly. In the v0 probe flow neither is
 * automatic — the probe surface in 7.3b will wire it.
 */
export async function runAutoEmit(ctx: AutoEmitContext): Promise<AutoEmitOutcome> {
  try {
    const sourceAmount = ctx.snapshot.amount;
    const orderAmount = ctx.orderAmount;
    if (orderAmount <= 0n) {
      return { status: 'failed', reason: `orderAmount must be > 0, got ${orderAmount}` };
    }
    if (orderAmount > sourceAmount) {
      return {
        status: 'failed',
        reason: `orderAmount (${orderAmount}) exceeds seller's holding (${sourceAmount})`,
      };
    }
    const changeAmount = sourceAmount - orderAmount;
    const isSplit = changeAmount > 0n;

    const core = await ensureSparkCoreReady();
    // Placeholder beneficiary outpoints — never resolved on chain in the
    // Spark flow (see [[feedback_no_synthetic_l1_witness]]).
    const buyerTxid = '00'.repeat(32);
    // Distinct dummy txid for the seller-change seal so the two outputs
    // have distinct placeholder allocations (avoids any duplicate-seal
    // ambiguity downstream).
    const sellerTxid = '01' + '00'.repeat(31);

    let newCommitIdHex: string;
    let newTransitionHex: string;
    if (ctx.snapshot.prevTransitionHex) {
      // Depth-3 link: genesis → prev_transition → T_new.
      if (isSplit) {
        const t = core.buildNiaTransitionMultiOutputFromPrev(
          ctx.snapshot.prevTransitionHex,
          ctx.snapshot.genesisHex,
          ctx.snapshot.consumeIndex,
          [orderAmount.toString(), changeAmount.toString()],
          [buyerTxid, sellerTxid],
          new Uint32Array([0, 1]),
        );
        try {
          newCommitIdHex = t.commitIdHex;
          newTransitionHex = t.transitionHex;
        } finally {
          t.free();
        }
      } else {
        const t = core.buildNiaTransitionFromPrev(
          ctx.snapshot.prevTransitionHex,
          ctx.snapshot.genesisHex,
          ctx.snapshot.consumeIndex,
          orderAmount,
          buyerTxid,
          0,
        );
        try {
          newCommitIdHex = t.commitIdHex;
          newTransitionHex = t.transitionHex;
        } finally {
          t.free();
        }
      }
    } else {
      // Depth-2 link: genesis → T_new (no prev transition).
      if (isSplit) {
        const t = core.buildNiaTransitionMultiOutput(
          ctx.snapshot.genesisHex,
          ctx.snapshot.consumeIndex,
          [orderAmount.toString(), changeAmount.toString()],
          [buyerTxid, sellerTxid],
          new Uint32Array([0, 1]),
        );
        try {
          newCommitIdHex = t.commitIdHex;
          newTransitionHex = t.transitionHex;
        } finally {
          t.free();
        }
      } else {
        const t = core.buildNiaTransition(
          ctx.snapshot.genesisHex,
          ctx.snapshot.consumeIndex,
          orderAmount,
          buyerTxid,
          0,
        );
        try {
          newCommitIdHex = t.commitIdHex;
          newTransitionHex = t.transitionHex;
        } finally {
          t.free();
        }
      }
    }

    // SparkUtkProof for the seller's pre-swap leaf. Lets the buyer
    // optionally verify the seller indeed held a leaf with verifyingKey ==
    // deriveVerifyingKey(uBase, msg, operator) at the time the binding
    // existed — pure provenance signal; the buyer's current leaf is vanilla.
    const proof = new core.SparkUtkProofJs(ctx.snapshot.uBaseHex, ctx.snapshot.operatorPublicKeyHex);
    let proofHex: string;
    try {
      proofHex = proof.encode();
    } finally {
      proof.free();
    }

    const buyerOutputIndex = 0;
    const unsigned: UnsignedEnvelopeV4 = {
      v: 4,
      sender: ctx.myNpub,
      senderIdentityPubkey: ctx.mySparkIdentityPubkey,
      createdAt: new Date().toISOString(),
      kind: 'settlement-consignment-v1',
      proofHex,
      leafReference: {
        id: ctx.snapshot.lockedLeafId,
        treeId: ctx.snapshot.treeId,
        value: ctx.snapshot.value,
        network: ctx.snapshot.network,
        verifyingPublicKey: ctx.snapshot.verifyingPublicKeyHex,
        msgHex: ctx.snapshot.msgHex,
        transitionHex: newTransitionHex,
        prevGenesisHex: ctx.snapshot.genesisHex,
        ...(ctx.snapshot.prevTransitionHex
          ? { prevTransitionHex: ctx.snapshot.prevTransitionHex }
          : {}),
        // Emit buyerOutputIndex only on multi-output transitions. For
        // single-output (legacy) transitions, absence implies 0 — keeps
        // wire compat with envelopes posted before 7.3.
        ...(isSplit ? { buyerOutputIndex } : {}),
      },
    };

    const senderSignature = signEnvelope(unsigned, ctx.myNostrPrivkeyHex);
    const signed = { ...unsigned, senderSignature };

    const bodyBytes = new TextEncoder().encode(JSON.stringify(signed));
    const meta = await postConsignment(ctx.buyerNpub, bodyBytes);

    // -------- Post-emit local wallet state mutations (session 7.3b) ---------
    //
    // From this point on the envelope is queued at the relay and the chain
    // is committed. Failures in the steps below leave the relay state
    // intact and surface as `postEmitWarning` — the caller can recover by
    // running lazyRebindIfNeeded manually.

    let postEmitWarning: string | undefined;

    // 1. Persist T_new in the seller's local rgbStash so subsequent
    //    `scanBinding` / `lazyRebindIfNeeded` calls see it as the chain
    //    head. Idempotent on commitId; safe to re-run on retries.
    try {
      const outputs = isSplit
        ? [{ amount: orderAmount.toString() }, { amount: changeAmount.toString() }]
        : [{ amount: orderAmount.toString() }];
      addTransition({
        commitId: newCommitIdHex.toLowerCase(),
        prevContractId: ctx.snapshot.contractId,
        outputs,
        transitionHex: newTransitionHex,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      postEmitWarning =
        `addTransition failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    // 2. The source leaf's binding is now spent (chain says so). Clear
    //    its pathTweak entry to keep the wallet view consistent with the
    //    emitted chain. In the future OrderBookPanel HTLC flow this is a
    //    no-op (the leaf is gone from the wallet anyway); in the current
    //    probe flow it's what avoids the "source leaf still claims its
    //    units" inconsistency.
    clearPathTweak(ctx.snapshot.lockedLeafId);

    // 3. On a partial fill, mint a fresh seller leaf bound to T_new's
    //    change output so the seller still has a live binding for their
    //    remaining units. Picks any vanilla leaf as carrier (the just-
    //    cleared source leaf is usually the natural candidate).
    let changeLeafId: string | undefined;
    if (isSplit) {
      try {
        const leaves = await listSparkLeaves();
        const boundIds = new Set(listPathTweaks().map((t) => t.currentLeafId));
        const vanillaCandidates = leaves.filter((l) => !boundIds.has(l.id));
        if (vanillaCandidates.length === 0) {
          postEmitWarning =
            'change-leaf mint skipped: no vanilla source leaf available — ' +
            'rebind manually later via the Order book panel.';
        } else {
          const source = [...vanillaCandidates].sort((a, b) => a.value - b.value)[0];
          const mintResult = await mintViaSelfTransfer(
            source.id,
            hexToBytes(newCommitIdHex),
            changeAmount,
            /* consumeIndex= */ 1,
            { transitionHex: newTransitionHex, prevGenesisHex: ctx.snapshot.genesisHex },
          );
          changeLeafId = mintResult.leaf.id;
        }
      } catch (e) {
        postEmitWarning =
          `change-leaf mint failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    return {
      status: 'emitted',
      envelopeId: meta.id,
      bytesPosted: meta.size,
      newCommitIdHex,
      newTransitionHex,
      payloadKind: ctx.snapshot.payloadKind,
      outputCount: isSplit ? 2 : 1,
      buyerOutputIndex,
      changeAmount,
      ...(changeLeafId ? { changeLeafId } : {}),
      ...(postEmitWarning ? { postEmitWarning } : {}),
    };
  } catch (e) {
    return {
      status: 'failed',
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
