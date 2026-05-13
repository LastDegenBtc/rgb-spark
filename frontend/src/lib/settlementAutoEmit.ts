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
import { getPathTweak } from './rgbAwareSigner';
import { listSparkLeaves } from './sparkWallet';
import { postConsignment } from './consignmentRelay';
import { signEnvelope, type UnsignedEnvelopeV4 } from './envelopeSign';

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
  /** The amount we'll allocate in T_new. Equals the prior allocation —
   *  in v0 with no split/merge, that's the contract's full supply. */
  amount: bigint;
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
  // niaGenesisMetadata re-validates the consignment AND returns ticker/name/
  // supply/contractId in one shot. Trustless: extracted from the schema-
  // validated bytes themselves, not from a local stash that may be empty
  // or stale (e.g. on a wallet that pre-dates rgbStash persistence).
  let contractId: string;
  let supply: bigint;
  try {
    const meta = core.niaGenesisMetadata(genesisHex);
    try {
      contractId = meta.contractId;
      supply = BigInt(meta.supply);
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
      amount: supply,
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
}

export type AutoEmitOutcome =
  | {
      status: 'emitted';
      envelopeId: string;
      bytesPosted: number;
      newCommitIdHex: string;
      newTransitionHex: string;
      payloadKind: 'transition' | 'genesis';
    }
  | { status: 'failed'; reason: string };

/**
 * Build T_new on top of the snapshot, compose & sign an envelope v4, POST
 * to the buyer's relay queue. Pure async — no throws on expected failure
 * paths, just `{status: 'failed'}` with a reason.
 */
export async function runAutoEmit(ctx: AutoEmitContext): Promise<AutoEmitOutcome> {
  try {
    const core = await ensureSparkCoreReady();
    // Placeholder beneficiary outpoint — never resolved on chain in the
    // Spark flow (see [[feedback_no_synthetic_l1_witness]]).
    const dummyTxid = '00'.repeat(32);

    let newCommitIdHex: string;
    let newTransitionHex: string;
    if (ctx.snapshot.prevTransitionHex) {
      // Depth-3 link: genesis → prev_transition → T_new.
      const t = core.buildNiaTransitionFromPrev(
        ctx.snapshot.prevTransitionHex,
        ctx.snapshot.genesisHex,
        0,
        ctx.snapshot.amount,
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
      // Depth-2 link: genesis → T_new (no prev transition).
      const t = core.buildNiaTransition(
        ctx.snapshot.genesisHex,
        0,
        ctx.snapshot.amount,
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
      },
    };

    const senderSignature = signEnvelope(unsigned, ctx.myNostrPrivkeyHex);
    const signed = { ...unsigned, senderSignature };

    const bodyBytes = new TextEncoder().encode(JSON.stringify(signed));
    const meta = await postConsignment(ctx.buyerNpub, bodyBytes);

    return {
      status: 'emitted',
      envelopeId: meta.id,
      bytesPosted: meta.size,
      newCommitIdHex,
      newTransitionHex,
      payloadKind: ctx.snapshot.payloadKind,
    };
  } catch (e) {
    return {
      status: 'failed',
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
