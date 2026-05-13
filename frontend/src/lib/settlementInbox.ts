// Settlement consignment inbox (Phase 1C/clean session 5.3b).
//
// Buyer-side counterpart to settlementAutoEmit.ts. A long-running
// poller fetches new envelopes from `/consignment/<myNpub>`, validates
// each end-to-end (BIP-340 sig + schema chain + Spark-UTK binding + the
// `msgHex == seller's pre-swap binding` cross-check), and auto-populates
// rgbStash (contracts + transitions, both idempotent). Accepted
// envelopes are acked so the relay queue stays clean; rejected envelopes
// remain on the queue so a developer can manually inspect them via
// ConsignmentLab in the Developer lab.
//
// Trust posture (mirrors settlementAutoEmit.ts):
//   - BIP-340 signature is the only "this came from a real sender"
//     claim — relay is a transport, never custody. The signer's npub
//     is committed in the envelope's `sender` field.
//   - All RGB metadata (contractId, ticker, name, supply) is extracted
//     from the schema-validated genesis bytes via `niaGenesisMetadata`.
//     The seller cannot lie about ticker/name in the envelope JSON.
//   - The Spark-UTK leaf binding check (deriveVerifyingKey ==
//     leafReference.verifyingPublicKey) proves the seller indeed held a
//     leaf bound to msgHex at some past moment. It does NOT prove the
//     buyer atomically received that leaf — that's a separate
//     out-of-band confirmation (the buyer's own HTLC settlement log).

import { ensureSparkCoreReady } from './sparkCore';
import {
  listConsignments,
  fetchConsignment,
  ackConsignment,
  type ConsignmentMeta,
} from './consignmentRelay';
import { addContract, addTransition, getContractById } from './rgbStash';
import { verifyEnvelope, type SignedEnvelopeV4 } from './envelopeSign';

const SETTLEMENT_KIND = 'settlement-consignment-v1';

export type AcceptResult = {
  status: 'accepted';
  contractId: string;
  ticker: string;
  name: string;
  newCommitIdHex?: string;
  /** Whether this envelope mutated the local stash (false on idempotent
   *  re-process where nothing new was added). */
  mutated: boolean;
};

export type EnvelopeOutcome =
  | AcceptResult
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; reason: string };

export interface InboxTickResult {
  startedAt: string;
  finishedAt: string;
  fetched: number;
  /** Per-envelopeId outcome, in fetch order. */
  outcomes: Array<{ id: string; outcome: EnvelopeOutcome }>;
}

export interface InboxStatus {
  /** Whether a poller is currently attached to a wallet. */
  attached: boolean;
  /** ISO timestamp of the last tick's start. null if no tick yet. */
  lastTickAt: string | null;
  inProgress: boolean;
  /** Cumulative count of envelopes accepted (across all ticks since
   *  start) — useful for a "you got mail" indicator. */
  acceptedCount: number;
  /** Most recent tick result, for in-depth UI inspection. */
  lastTick: InboxTickResult | null;
  /** Most recent fatal error (network/auth). Cleared on next successful tick. */
  lastError: string | null;
}

// ------- Envelope decoding ---------------------------------------------------

interface ParsedSettlementEnvelope extends SignedEnvelopeV4 {
  kind: typeof SETTLEMENT_KIND;
  leafReference: NonNullable<SignedEnvelopeV4['leafReference']>;
}

function isSettlementEnvelope(env: unknown): env is ParsedSettlementEnvelope {
  if (!env || typeof env !== 'object') return false;
  const e = env as Record<string, unknown>;
  return (
    e.v === 4 &&
    e.kind === SETTLEMENT_KIND &&
    typeof e.proofHex === 'string' &&
    typeof e.senderSignature === 'string' &&
    typeof e.sender === 'string' &&
    e.leafReference !== undefined &&
    typeof e.leafReference === 'object'
  );
}

/**
 * Pure validator: takes raw bytes off the relay, runs every check, and
 * returns a structured outcome. No side effects — `processInbox` is the
 * one that mutates rgbStash.
 *
 * Network-level cross-check (caller responsibility): the envelope was
 * routed to `myNpub`'s relay queue, so the seller intended us as the
 * recipient. We don't re-encode that into the validator since the relay
 * already enforces it.
 */
export async function validateSettlementEnvelope(
  bytes: Uint8Array,
): Promise<EnvelopeOutcome> {
  let env: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    env = JSON.parse(text);
  } catch (e) {
    return { status: 'skipped', reason: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isSettlementEnvelope(env)) {
    return { status: 'skipped', reason: 'not a settlement-consignment-v1 envelope' };
  }
  const e = env;

  // 1. BIP-340 sig over the canonicalized envelope.
  const sigCheck = verifyEnvelope(e);
  if (sigCheck.kind !== 'ok') {
    return {
      status: 'rejected',
      reason: `BIP-340 verify failed: ${sigCheck.kind === 'fail' ? sigCheck.reason : sigCheck.kind}`,
    };
  }

  const leafRef = e.leafReference;
  const genesisHex = leafRef.prevGenesisHex ?? leafRef.consignmentHex;
  if (!genesisHex) {
    return { status: 'rejected', reason: 'leafReference missing both prevGenesisHex and consignmentHex' };
  }
  if (!leafRef.msgHex) {
    return { status: 'rejected', reason: 'leafReference missing msgHex' };
  }

  const core = await ensureSparkCoreReady();

  // 2. Trustless metadata extraction from the genesis bytes themselves.
  let contractId: string;
  let ticker: string;
  let name: string;
  try {
    const meta = core.niaGenesisMetadata(genesisHex);
    try {
      contractId = meta.contractId;
      ticker = meta.ticker;
      name = meta.name;
    } finally {
      meta.free();
    }
  } catch (err) {
    return {
      status: 'rejected',
      reason: `niaGenesisMetadata failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Schema chain validation. Three modes by what the leafReference carries:
  //    - depth-3 (prevTransitionHex + transitionHex + prevGenesisHex):
  //      validate chain genesis → prev → new; msgHex must == prev.id().
  //    - depth-2 (transitionHex + prevGenesisHex): validate genesis → new;
  //      msgHex must == new.id().
  //    - depth-1 (consignmentHex only): genesis is the binding target;
  //      msgHex must == contractId.
  let newCommitIdHex: string | undefined;
  let prevCommitIdHex: string | undefined;
  try {
    if (leafRef.prevTransitionHex && leafRef.transitionHex && leafRef.prevGenesisHex) {
      newCommitIdHex = core
        .validateNiaTransitionFromPrev(
          leafRef.transitionHex,
          leafRef.prevTransitionHex,
          leafRef.prevGenesisHex,
        )
        .toLowerCase();
      prevCommitIdHex = core
        .validateNiaTransition(leafRef.prevTransitionHex, leafRef.prevGenesisHex)
        .toLowerCase();
      if (leafRef.msgHex.toLowerCase() !== prevCommitIdHex) {
        return {
          status: 'rejected',
          reason: `msgHex (${leafRef.msgHex.slice(0, 12)}…) != prevTransition.id() (${prevCommitIdHex.slice(0, 12)}…)`,
        };
      }
    } else if (leafRef.transitionHex && leafRef.prevGenesisHex) {
      newCommitIdHex = core
        .validateNiaTransition(leafRef.transitionHex, leafRef.prevGenesisHex)
        .toLowerCase();
      if (leafRef.msgHex.toLowerCase() !== newCommitIdHex) {
        return {
          status: 'rejected',
          reason: `msgHex (${leafRef.msgHex.slice(0, 12)}…) != transition.id() (${newCommitIdHex.slice(0, 12)}…)`,
        };
      }
    } else if (leafRef.consignmentHex) {
      if (leafRef.msgHex.toLowerCase() !== contractId.toLowerCase()) {
        return {
          status: 'rejected',
          reason: `msgHex (${leafRef.msgHex.slice(0, 12)}…) != contractId (${contractId.slice(0, 12)}…)`,
        };
      }
    } else {
      return { status: 'rejected', reason: 'leafReference has no chain payload' };
    }
  } catch (err) {
    return {
      status: 'rejected',
      reason: `schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Spark-UTK leaf-binding cross-check.
  try {
    const proof = core.SparkUtkProofJs.decode(e.proofHex);
    let derived: string;
    try {
      derived = core.deriveVerifyingKey(proof.uBase, leafRef.msgHex, proof.operator).toLowerCase();
    } finally {
      proof.free();
    }
    if (derived !== leafRef.verifyingPublicKey.toLowerCase()) {
      return {
        status: 'rejected',
        reason: `deriveVerifyingKey(uBase, msgHex, operator) != leafReference.verifyingPublicKey`,
      };
    }
  } catch (err) {
    return {
      status: 'rejected',
      reason: `proof decode/derive failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // All checks passed — stash population happens in processInbox (which
  // owns the side effects). Surface the data the caller needs.
  return {
    status: 'accepted',
    contractId,
    ticker,
    name,
    newCommitIdHex,
    // `mutated` is filled in by processInbox after addContract/addTransition;
    // the validator can't know whether the entries pre-exist in stash.
    mutated: false,
  };
}

// ------- One-shot processing -------------------------------------------------

interface ProcessOpts {
  /** Override the stash mutators — only the test surface uses this. */
  stashSink?: {
    addContract: typeof addContract;
    addTransition: typeof addTransition;
    getContractById: typeof getContractById;
  };
}

/**
 * Single inbox tick: list, fetch, validate, stash, ack. Used by the
 * poller AND directly callable for tests / manual flush.
 */
export async function processInbox(
  myNpub: string,
  opts?: ProcessOpts,
): Promise<InboxTickResult> {
  const sink = opts?.stashSink ?? { addContract, addTransition, getContractById };
  const startedAt = new Date().toISOString();
  const outcomes: Array<{ id: string; outcome: EnvelopeOutcome }> = [];

  let metas: ConsignmentMeta[];
  try {
    metas = await listConsignments(myNpub);
  } catch (e) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      fetched: 0,
      outcomes: [
        {
          id: '*list*',
          outcome: {
            status: 'rejected',
            reason: `listConsignments failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        },
      ],
    };
  }

  for (const meta of metas) {
    let bytes: Uint8Array;
    try {
      bytes = await fetchConsignment(myNpub, meta.id);
    } catch (e) {
      outcomes.push({
        id: meta.id,
        outcome: {
          status: 'rejected',
          reason: `fetchConsignment failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
      continue;
    }

    const outcome = await validateSettlementEnvelope(bytes);

    if (outcome.status === 'accepted') {
      // Parse once more to recover the timestamps/payload needed for stash
      // entries. The validator already proved this round-trips cleanly.
      const env = JSON.parse(new TextDecoder().decode(bytes)) as ParsedSettlementEnvelope;
      const leafRef = env.leafReference;
      const genesisHex = leafRef.prevGenesisHex ?? leafRef.consignmentHex!;

      const preexisting = sink.getContractById(outcome.contractId) !== undefined;
      sink.addContract({
        contractId: outcome.contractId,
        ticker: outcome.ticker,
        name: outcome.name,
        supply: await readSupply(genesisHex),
        consignmentHex: genesisHex,
        createdAt: env.createdAt,
      });

      // Persist the chain links we know about. addTransition is keyed by
      // commitId and idempotent, so re-arrival of the same envelope is safe.
      if (leafRef.prevTransitionHex && leafRef.transitionHex) {
        const supply = await readSupply(genesisHex);
        if (outcome.newCommitIdHex) {
          sink.addTransition({
            commitId: outcome.newCommitIdHex,
            prevContractId: outcome.contractId,
            amount: supply,
            transitionHex: leafRef.transitionHex,
            createdAt: env.createdAt,
          });
        }
        // Also persist the prev (seller's pre-swap state) so the user can
        // see the full chain in their stash UI.
        sink.addTransition({
          commitId: leafRef.msgHex!.toLowerCase(),
          prevContractId: outcome.contractId,
          amount: supply,
          transitionHex: leafRef.prevTransitionHex,
          createdAt: env.createdAt,
        });
      } else if (leafRef.transitionHex && outcome.newCommitIdHex) {
        const supply = await readSupply(genesisHex);
        sink.addTransition({
          commitId: outcome.newCommitIdHex,
          prevContractId: outcome.contractId,
          amount: supply,
          transitionHex: leafRef.transitionHex,
          createdAt: env.createdAt,
        });
      }

      const acceptResult: AcceptResult = {
        status: 'accepted',
        contractId: outcome.contractId,
        ticker: outcome.ticker,
        name: outcome.name,
        newCommitIdHex: outcome.newCommitIdHex,
        mutated: !preexisting,
      };
      outcomes.push({ id: meta.id, outcome: acceptResult });

      // Ack to clear the queue. Failures here are non-fatal — we'd rather
      // double-process (stash mutations are idempotent) than re-fetch on
      // every tick.
      try {
        await ackConsignment(myNpub, meta.id);
      } catch {
        /* tolerated */
      }
    } else {
      outcomes.push({ id: meta.id, outcome });
      // Don't ack — leave on queue for dev inspection via ConsignmentLab.
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    fetched: metas.length,
    outcomes,
  };
}

async function readSupply(genesisHex: string): Promise<string> {
  const core = await ensureSparkCoreReady();
  const meta = core.niaGenesisMetadata(genesisHex);
  try {
    return meta.supply;
  } finally {
    meta.free();
  }
}

// ------- Poller --------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 8_000;

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let pollerNpub: string | null = null;
let pollerInProgress = false;
const status: InboxStatus = {
  attached: false,
  lastTickAt: null,
  inProgress: false,
  acceptedCount: 0,
  lastTick: null,
  lastError: null,
};
const listeners = new Set<(s: InboxStatus) => void>();

function snapshot(): InboxStatus {
  return { ...status, lastTick: status.lastTick };
}

function notify(): void {
  const s = snapshot();
  for (const l of listeners) l(s);
}

async function tick(npubAtSchedule: string): Promise<void> {
  // Reject ticks for a stale npub (the user logged out / switched wallets
  // before this scheduled tick fired).
  if (pollerInProgress || pollerNpub !== npubAtSchedule) return;
  pollerInProgress = true;
  status.inProgress = true;
  notify();
  try {
    const result = await processInbox(npubAtSchedule);
    status.lastTick = result;
    status.lastTickAt = result.startedAt;
    status.lastError = null;
    for (const o of result.outcomes) {
      if (o.outcome.status === 'accepted' && o.outcome.mutated) status.acceptedCount += 1;
    }
  } catch (e) {
    status.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    pollerInProgress = false;
    status.inProgress = false;
    notify();
  }
}

export function startInboxPoller(myNpub: string, intervalMs = DEFAULT_INTERVAL_MS): void {
  stopInboxPoller();
  pollerNpub = myNpub;
  status.attached = true;
  status.lastTickAt = null;
  status.lastTick = null;
  status.acceptedCount = 0;
  status.lastError = null;
  notify();
  // Fire one immediately, then on interval.
  void tick(myNpub);
  pollerTimer = setInterval(() => void tick(myNpub), intervalMs);
}

export function stopInboxPoller(): void {
  if (pollerTimer) clearInterval(pollerTimer);
  pollerTimer = null;
  pollerNpub = null;
  status.attached = false;
  status.inProgress = false;
  status.lastTickAt = null;
  status.lastTick = null;
  status.lastError = null;
  notify();
}

export function subscribeInbox(cb: (s: InboxStatus) => void): () => void {
  listeners.add(cb);
  cb(snapshot());
  return () => {
    listeners.delete(cb);
  };
}

/** Trigger an immediate tick from outside (UI button / manual flush). */
export function flushInboxNow(): Promise<void> {
  const npub = pollerNpub;
  if (!npub) return Promise.resolve();
  return tick(npub);
}
