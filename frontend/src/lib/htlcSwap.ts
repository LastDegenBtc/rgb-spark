// HTLC atomic-swap layer for Phase 1C.
//
// Thin typed wrappers around the four Spark coordinator RPCs that were
// probed and confirmed working on mainnet 2026-05-12 (see
// `reference_spark_htlc_primitive` in agent memory + `htlcProbe.ts` for
// the empirical evidence). Together they form a classical HTLC
// (hash-time-locked contract) — equivalent to L1 PSBT-based atomic swap
// or Lightning HTLC routing — usable for trustless P2P leaf exchange
// without any first-mover trust, escrow agent, or relay custody.
//
// Layer above these primitives (orchestrator + UI) is in subsequent
// sessions; this module is intentionally framework-free so the
// orchestrator and the existing probe panels can share it.
//
// Out of scope here:
//   - Orderbook / matching (Phase 1C session 2 — relay extension).
//   - UX state machine (session 2/3, builds on this module).
//
// Trust model: rely only on
//   - Spark coordinator behaving per its proto spec (same trust we
//     already accept by using Spark at all);
//   - sha256 collision resistance + secp256k1 hardness.
// No counterparty trust. No relay-side fund custody. See
// `feedback_trustless_is_non_negotiable` in agent memory.

import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { KeyDerivationType } from '@buildonspark/spark-sdk';
import type { TreeNode } from '@buildonspark/spark-sdk/proto/spark';

// ----- Internal SDK access shim --------------------------------------------
//
// All wrappers reach into the SparkWallet's private internals (config,
// lightningService, connectionManager). The shape below matches what the
// SDK exposes at runtime; we centralize the cast here so callers don't
// re-import the same `unknown as ...` pattern everywhere.

interface LeafKeyTweak {
  leaf: TreeNode;
  keyDerivation: { type: KeyDerivationType; path?: string };
  newKeyDerivation: { type: KeyDerivationType; path?: string };
  receiverIdentityPublicKey: Uint8Array;
}

interface SparkClient {
  query_preimage: (req: {
    paymentHash: Uint8Array;
    receiverIdentityPubkey: Uint8Array;
  }) => Promise<{ preimage?: Uint8Array }>;
  query_htlc: (req: {
    paymentHashes: Uint8Array[];
    identityPublicKey: Uint8Array;
    status?: number;
    limit: number;
    offset: number;
    transferIds: string[];
    matchRole: number;
  }) => Promise<{
    preimageRequests: Array<{
      status?: number;
      paymentHash?: Uint8Array;
      transfer?: unknown;
    }>;
    offset: number;
  }>;
}

interface WalletInternals {
  config: {
    getCoordinatorAddress: () => string;
    signer: { getIdentityPublicKey: () => Promise<Uint8Array> };
  };
  lightningService: {
    swapNodesForPreimage: (params: {
      leaves: LeafKeyTweak[];
      receiverIdentityPubkey: Uint8Array;
      paymentHash: Uint8Array;
      invoiceString?: string;
      isInboundPayment: boolean;
      feeSats?: number;
      amountSatsToSend?: number;
      expiryTime: Date;
    }) => Promise<unknown>;
    providePreimage: (preimage: Uint8Array) => Promise<unknown>;
    connectionManager: {
      createSparkClient: (addr: string) => Promise<SparkClient>;
    };
    config: {
      getCoordinatorAddress: () => string;
      signer: { getIdentityPublicKey: () => Promise<Uint8Array> };
    };
  };
  getLeaves: (isBalanceCheck?: boolean) => Promise<TreeNode[]>;
}

function asInternals(wallet: unknown): WalletInternals {
  return wallet as WalletInternals;
}

// ----- Public types --------------------------------------------------------

/**
 * Role the local wallet plays in an HTLC swap, used to disambiguate
 * `query_htlc` calls.
 *
 *   - `'receiver'`: this wallet is the recipient of leaves locked under H
 *     by a counterparty; we'll eventually call providePreimage(P) to claim.
 *   - `'sender'`: this wallet locked leaves under H to a counterparty; we
 *     watch for the swap to either complete (PREIMAGE_SHARED → counterparty
 *     claimed) or RETURN (expiry hit → leaves come back to us).
 */
export type HtlcRole = 'receiver' | 'sender';

/**
 * Mirror of `PreimageRequestStatus` from the SDK proto. Exposed as a typed
 * union so callers don't have to import the proto enum (which forces a
 * heavy SDK dependency in code that just wants to inspect HTLC state).
 *
 *   - `waiting`: lock is live, no preimage revealed yet.
 *   - `shared`: preimage has been revealed; the receiver-side can claim.
 *   - `returned`: lock has expired and leaves have been refunded to sender.
 *   - `unknown`: status not set on the response.
 */
export type HtlcStatus = 'waiting' | 'shared' | 'returned' | 'unknown';

function decodeStatus(n: number | undefined): HtlcStatus {
  switch (n) {
    case 0:
      return 'waiting';
    case 1:
      return 'shared';
    case 2:
      return 'returned';
    default:
      return 'unknown';
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
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

// ----- Preimage helpers ----------------------------------------------------

/**
 * Generate a fresh 32-byte preimage and its paymentHash. The preimage is
 * the swap secret — whoever holds it can claim leaves locked under the
 * paymentHash via `revealAndClaim`. By convention (matching classical
 * HTLC routing), the SELLER generates the preimage and the BUYER discovers
 * it via `queryRevealedPreimage` after the seller reveals.
 */
export function newPreimagePair(): { preimage: Uint8Array; paymentHash: Uint8Array } {
  const preimage = new Uint8Array(32);
  crypto.getRandomValues(preimage);
  const paymentHash = sha256(preimage);
  return { preimage, paymentHash };
}

// ----- Primitive 1: lock leaves under a paymentHash ------------------------

/**
 * Lock one or more leaves under a paymentHash, payable to the given
 * recipient identity pubkey, with an expiry after which the leaves
 * automatically return to the sender.
 *
 * This wraps `swapNodesForPreimage` with `invoiceString: ''`, the no-LN
 * code path confirmed working in probe session 0. The coordinator does
 * NOT route any Lightning payment — the call simply registers a hash-
 * locked transfer in the coordinator state, with no `bolt11Invoice`
 * required and no LSP involvement.
 *
 * Caller usually:
 *   - Picks `leaves` from `wallet.getLeaves()` matching the desired sat
 *     amount (sum of leaf.value must cover what's being offered).
 *   - Uses the `keyDerivation: { type: LEAF, path: leaf.id }` shape we
 *     already use in `mintViaSelfTransfer`.
 *   - Sets `expiryTime` according to the HTLC asymmetry rule: the SENDER
 *     side (this side) gets a LONGER expiry than the RECEIVER side, so
 *     the receiver has a safety margin to claim after the preimage is
 *     revealed. Concrete defaults: seller's lock = 60 min, buyer's lock
 *     = 30 min.
 */
export async function lockUnderHash(
  wallet: unknown,
  params: {
    leaves: TreeNode[];
    recipientIdentityPubkey: Uint8Array;
    paymentHash: Uint8Array;
    expiryTime: Date;
  },
): Promise<void> {
  if (params.paymentHash.length !== 32) {
    throw new Error(`paymentHash must be 32 bytes, got ${params.paymentHash.length}`);
  }
  if (params.recipientIdentityPubkey.length !== 33) {
    throw new Error(
      `recipientIdentityPubkey must be 33-byte compressed pubkey, got ${params.recipientIdentityPubkey.length}`,
    );
  }
  if (params.leaves.length === 0) {
    throw new Error('lockUnderHash: at least one leaf required');
  }
  if (params.expiryTime.getTime() <= Date.now()) {
    throw new Error('expiryTime must be in the future');
  }
  const w = asInternals(wallet);
  const leafKeyTweaks: LeafKeyTweak[] = params.leaves.map((leaf) => ({
    leaf,
    keyDerivation: { type: KeyDerivationType.LEAF, path: leaf.id },
    newKeyDerivation: { type: KeyDerivationType.RANDOM },
    receiverIdentityPublicKey: params.recipientIdentityPubkey,
  }));
  await w.lightningService.swapNodesForPreimage({
    leaves: leafKeyTweaks,
    receiverIdentityPubkey: params.recipientIdentityPubkey,
    paymentHash: params.paymentHash,
    invoiceString: '',
    isInboundPayment: false,
    expiryTime: params.expiryTime,
  });
}

// ----- Primitive 2: reveal preimage and claim ------------------------------

/**
 * Reveal a preimage to claim leaves the local wallet is the receiver of.
 * The coordinator looks up active HTLCs under `sha256(preimage)` where
 * this wallet's identityPublicKey is the receiver, and credits the
 * leaves to this wallet.
 *
 * After this call:
 *   - Locally: the claimed leaves appear in `getLeaves()` shortly.
 *   - Globally: the coordinator records the preimage under the
 *     paymentHash, retrievable by any party via `queryRevealedPreimage`.
 *     This is the atomicity hook — once one party reveals to claim,
 *     the OTHER party can read the preimage out and claim their leg.
 */
export async function revealAndClaim(
  wallet: unknown,
  preimage: Uint8Array,
): Promise<void> {
  if (preimage.length !== 32) {
    throw new Error(`preimage must be 32 bytes, got ${preimage.length}`);
  }
  const w = asInternals(wallet);
  await w.lightningService.providePreimage(preimage);
}

// ----- Primitive 3: query revealed preimage (receiver-side) ----------------

/**
 * Coordinator-side check: has my counterparty revealed the preimage for
 * an HTLC under this paymentHash where they are the receiver of MY lock?
 *
 * Despite its name, the proto field `receiverIdentityPubkey` designates
 * the receiver of an HTLC RELATIVE TO THE CALLER — i.e., the counterparty,
 * not the local wallet. The coordinator authenticates the caller as
 * sender (via gRPC auth identity), looks up `paymentHash → HTLC where
 * sender = caller and receiver = receiverIdentityPubkey`, and returns
 * the preimage if it has been revealed by that receiver.
 *
 * Returns null if the preimage hasn't been revealed yet, or if no HTLC
 * matches the (caller-as-sender, counterparty-as-receiver, paymentHash)
 * triple.
 *
 * Typical buyer polling loop in an atomic swap:
 *   while (status != claimed) {
 *     const p = await queryRevealedPreimage(wallet, H, sellerPubkey);
 *     if (p) { await revealAndClaim(wallet, p); break; }
 *     await sleep(POLL_INTERVAL);
 *   }
 *
 * Empirical cross-wallet smoke test 2026-05-12: passing `self` as
 * `counterpartyPubkey` (the early reading of the proto field name)
 * yielded `INVALID_ARGUMENT: authenticated identity X does not match
 * transfer sender Y` because the coordinator was matching against a
 * different HTLC than expected. Pass the counterparty's pubkey.
 */
export async function queryRevealedPreimage(
  wallet: unknown,
  paymentHash: Uint8Array,
  counterpartyPubkey: Uint8Array,
): Promise<Uint8Array | null> {
  if (paymentHash.length !== 32) {
    throw new Error(`paymentHash must be 32 bytes, got ${paymentHash.length}`);
  }
  if (counterpartyPubkey.length !== 33) {
    throw new Error(
      `counterpartyPubkey must be 33-byte compressed pubkey, got ${counterpartyPubkey.length}`,
    );
  }
  const w = asInternals(wallet);
  const client = await w.lightningService.connectionManager.createSparkClient(
    w.lightningService.config.getCoordinatorAddress(),
  );
  const resp = await client.query_preimage({
    paymentHash,
    receiverIdentityPubkey: counterpartyPubkey,
  });
  if (!resp.preimage || resp.preimage.length === 0) return null;
  if (resp.preimage.length !== 32) {
    throw new Error(
      `query_preimage returned ${resp.preimage.length}-byte value, expected 32`,
    );
  }
  return resp.preimage;
}

// ----- Primitive 4: enumerate / inspect this wallet's HTLCs ----------------

export interface HtlcRecord {
  paymentHashHex: string;
  status: HtlcStatus;
  /** Total sats locked under this HTLC by the sender, as reported by the
   *  coordinator (sum of all leaves in the associated transfer). Used by
   *  the seller side to verify the buyer locked at least the agreed
   *  priceSats before revealing the preimage — without this check, a
   *  malicious buyer can lock less than agreed and the seller would
   *  still reveal, leading to underpay. Zero if the coordinator's
   *  response had no transfer attached (e.g., querying a status the
   *  swap left). */
  lockedSats: number;
  /** Raw response from the coordinator — kept opaque (the SDK proto type
   *  isn't re-exported here). Useful for debugging; production logic
   *  should rely on `status` + `paymentHashHex` + `lockedSats`. */
  raw: unknown;
}

/**
 * List HTLCs involving this wallet, scoped by role. Returns one entry
 * per paymentHash. Useful for:
 *   - Receiver: polling to discover newly-locked incoming swaps.
 *   - Sender: monitoring own locks for status transitions
 *     (WAITING → SHARED on counterparty claim, or → RETURNED on expiry).
 *
 * Filter via `paymentHashes` to narrow to specific swaps (cheaper than
 * listing all and filtering client-side).
 */
export async function queryPendingHtlcs(
  wallet: unknown,
  params: {
    role: HtlcRole;
    paymentHashes?: Uint8Array[];
    status?: HtlcStatus;
    limit?: number;
  } = { role: 'receiver' },
): Promise<HtlcRecord[]> {
  const w = asInternals(wallet);
  const identityPubkey = await w.config.signer.getIdentityPublicKey();
  const client = await w.lightningService.connectionManager.createSparkClient(
    w.lightningService.config.getCoordinatorAddress(),
  );
  const matchRole = params.role === 'receiver' ? 0 : 1;
  const statusFilter = params.status
    ? params.status === 'waiting'
      ? 0
      : params.status === 'shared'
        ? 1
        : params.status === 'returned'
          ? 2
          : undefined
    : undefined;
  const resp = await client.query_htlc({
    paymentHashes: params.paymentHashes ?? [],
    identityPublicKey: identityPubkey,
    status: statusFilter,
    limit: params.limit ?? 100,
    offset: 0,
    transferIds: [],
    matchRole,
  });
  return resp.preimageRequests.map((r) => {
    // The proto puts the actual lock amount on the nested Transfer's
    // totalValue field. Sum is conceptual here — for a single-leaf or
    // multi-leaf HTLC the SE returns one Transfer that already
    // aggregates totalValue across all its leaves.
    const transfer = (r as unknown as { transfer?: { totalValue?: number | bigint } }).transfer;
    const rawTotal = transfer?.totalValue ?? 0;
    const lockedSats = typeof rawTotal === 'bigint' ? Number(rawTotal) : Number(rawTotal);
    return {
      paymentHashHex: r.paymentHash ? bytesToHex(r.paymentHash) : '',
      status: decodeStatus(r.status),
      lockedSats,
      raw: r,
    };
  });
}

// ----- Convenience: throwaway recipient pubkey -----------------------------

/**
 * Generate a fresh secp256k1 pubkey for which the caller does NOT hold
 * the privkey. Useful for probes / smoke tests where we want to lock
 * leaves to "someone we can't claim from" — guaranteed to refund at
 * expiry. NOT for production swaps (no counterparty would ever claim).
 */
export function throwawayRecipient(): { pubkey: Uint8Array; pubkeyHex: string } {
  const priv = secp256k1.utils.randomPrivateKey();
  const pubkey = secp256k1.getPublicKey(priv, true);
  return { pubkey, pubkeyHex: bytesToHex(pubkey) };
}

// ----- Orchestrator state machine ------------------------------------------
//
// Two flows that combine the four primitives into the full HTLC dance.
//
// Naming convention (matching the standard HTLC routing literature):
//   - SELLER = preimage-holder = the party who first reveals P.
//     They lock their asset to the BUYER with the LONGER expiry (T_A).
//     They claim the buyer's sats first; revealing P globally for H.
//   - BUYER  = preimage-discoverer = the party who polls for the reveal.
//     They lock their sats to the SELLER with the SHORTER expiry (T_B).
//     After P is revealed, they pull it via queryRevealedPreimage and
//     claim the seller's asset.
//
// Asymmetry T_A > T_B ensures the BUYER (slower side) has a safety
// margin after the SELLER reveals — without it, an adversarial seller
// could reveal just before T_B and the buyer would have no time to
// claim before their own expiry.
//
// Both flows are observable via an `onState` callback so a UI can
// render real-time progress, and resumable in spirit: each phase is
// idempotent against the coordinator state (the primitives themselves
// are stateless — phase tracking is purely client-side).

export type SwapPhase =
  | 'idle'
  | 'preparing'        // generating preimage / preflight checks
  | 'locking'          // calling lockUnderHash for our side
  | 'locked'           // our lock is in; waiting for the other side
  | 'awaiting-counterparty'  // (seller) polling for buyer's lock; (buyer) polling for reveal
  | 'revealing'        // calling revealAndClaim
  | 'awaiting-claim'   // (seller) preimage revealed, polling for claim to manifest
  | 'completed'        // swap settled on our side
  | 'expired'          // our lock returned to us (counterparty stalled)
  | 'reveal-without-claim'  // (seller) preimage public but claim never landed — atomicity broken
  | 'failed';          // error state — see message + cause

export interface SwapState {
  phase: SwapPhase;
  paymentHashHex: string;
  /** Human-readable message for UI logging. Updated on every transition. */
  message: string;
  /** ISO timestamp of the most recent phase transition. */
  updatedAt: string;
  /** Wall-clock expiry of this side's lock. */
  ourExpiry: Date;
  /** Only set after the swap completes — the revealed preimage (matches
   *  the one we generated for seller flow, or pulled for buyer flow). */
  revealedPreimageHex?: string;
  /** Set if the state machine terminates in `failed`. */
  cause?: string;
}

export type StateCallback = (state: Readonly<SwapState>) => void;

interface FlowResult {
  outcome: 'completed' | 'expired' | 'failed' | 'reveal-without-claim';
  state: SwapState;
  /** Buyer-side only: the leaf id that arrived in our wallet as a
   *  result of the claim. Caller uses this to pin the RGB rebind to
   *  the leaf actually received from the seller, instead of any
   *  vanilla leaf — the load-bearing trustlessness guarantee. */
  claimedLeafId?: string;
}

/** Default timeout for the post-reveal claim verification window.
 *  3 minutes is well within the seller's 1-hour lock expiry but long
 *  enough that the SDK's eventual-consistency claim of the buyer's leaf
 *  has time to manifest under normal network conditions. Beyond this we
 *  declare the swap broken (preimage public, claim unlanded) so the
 *  caller never emits a settlement consignment for an unsettled trade. */
const DEFAULT_CLAIM_VERIFY_MS = 3 * 60_000;

const DEFAULT_POLL_MS = 3_000;

function nowIso(): string { return new Date().toISOString(); }

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Seller-side flow. Generates the preimage, locks our asset to the
 * counterparty, waits for the counterparty's matching lock to appear,
 * then reveals the preimage to claim the counterparty's payment.
 *
 * Returns when the swap completes, our lock expires, or an error
 * terminates the flow. State transitions are reported via `onState`.
 */
export async function runSellerFlow(
  wallet: unknown,
  params: {
    /** Leaves we are giving up — the asset side. */
    assetLeaves: TreeNode[];
    /** Counterparty's Spark identity pubkey (33-byte compressed). */
    counterpartyPubkey: Uint8Array;
    /** Sat amount we expect the counterparty to lock for us. The flow
     *  considers a matching incoming HTLC to mean "any HTLC under H
     *  with receiver=us"; amount verification is on the caller — for
     *  v0 we trust the orderbook agreement, since the buyer can't
     *  trick us into claiming more than they locked. */
    expectedSatsFromBuyer: number;
    /** Our lock's expiry (T_A). Must be > buyer's T_B + safety margin. */
    expiryTime: Date;
    /** Optional pre-generated preimage. Default: fresh random. */
    preimage?: Uint8Array;
    /** Polling cadence while awaiting the buyer's lock. Default 3 s. */
    pollIntervalMs?: number;
    onState: StateCallback;
  },
): Promise<FlowResult> {
  const preimage = params.preimage ?? newPreimagePair().preimage;
  const paymentHash = sha256(preimage);
  const paymentHashHex = bytesToHex(paymentHash);
  const pollInterval = params.pollIntervalMs ?? DEFAULT_POLL_MS;

  const state: SwapState = {
    phase: 'preparing',
    paymentHashHex,
    message: 'generated preimage, preparing seller-side lock',
    updatedAt: nowIso(),
    ourExpiry: params.expiryTime,
  };
  params.onState({ ...state });

  // Phase 1: lock our asset to the counterparty.
  // Resumability: catch ALREADY_EXISTS, which means a previous run already
  // posted this lock (per the coordinator's per-(sender, paymentHash)
  // uniqueness constraint — see reference_spark_htlc_primitive). Treat as
  // a successful lock and continue to the awaiting-counterparty phase.
  state.phase = 'locking';
  state.message = `locking ${params.assetLeaves.length} leaf(es) under H to counterparty`;
  state.updatedAt = nowIso();
  params.onState({ ...state });
  try {
    await lockUnderHash(wallet, {
      leaves: params.assetLeaves,
      recipientIdentityPubkey: params.counterpartyPubkey,
      paymentHash,
      expiryTime: params.expiryTime,
    });
  } catch (e) {
    const errStr = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (errStr.includes('ALREADY_EXISTS')) {
      state.message = `lock already in place from a previous attempt — resuming`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
    } else {
      state.phase = 'failed';
      state.cause = errStr;
      state.message = `lockUnderHash failed: ${state.cause}`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      return { outcome: 'failed', state };
    }
  }

  state.phase = 'locked';
  state.message = `asset locked under H; awaiting counterparty's matching lock`;
  state.updatedAt = nowIso();
  params.onState({ ...state });

  // Phase 2: poll until we see an incoming HTLC under H to us, OR our
  // own lock expires (whichever comes first).
  state.phase = 'awaiting-counterparty';
  params.onState({ ...state });

  while (Date.now() < params.expiryTime.getTime()) {
    let incoming: HtlcRecord[] = [];
    try {
      incoming = await queryPendingHtlcs(wallet, {
        role: 'receiver',
        paymentHashes: [paymentHash],
        status: 'waiting',
        limit: 5,
      });
    } catch (e) {
      // Soft-fail on transient query errors; keep polling.
      state.message = `query error (will retry): ${e instanceof Error ? e.message : String(e)}`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      await sleep(pollInterval);
      continue;
    }
    if (incoming.length > 0) {
      state.message = `buyer's lock detected (status=${incoming[0].status})`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      break;
    }
    await sleep(pollInterval);
  }

  if (Date.now() >= params.expiryTime.getTime()) {
    state.phase = 'expired';
    state.message = `our lock expired before counterparty locked — leaves will refund automatically`;
    state.updatedAt = nowIso();
    params.onState({ ...state });
    return { outcome: 'expired', state };
  }

  // sprk.12.1 security gate: before we reveal the preimage (which
  // gives the buyer EVERYTHING they need to claim our asset), verify
  // the buyer's lock totalValue >= expectedSatsFromBuyer. Without
  // this a malicious buyer can lock e.g. 1 sat for a 1005-sat trade
  // and we'd reveal anyway, leading to a 1004-sat underpay.
  //
  // The expectedSatsFromBuyer is what we COMMITTED to in our order
  // (= our ask's priceSats, or the matching bid's priceSats). The
  // coordinator reports the buyer's actual lock totalValue on the
  // PreimageRequestWithTransfer.transfer.totalValue field, which we
  // surface as HtlcRecord.lockedSats.
  //
  // We re-query the latest HtlcRecord here (instead of using the
  // `incoming` snapshot from the polling loop) so the lockedSats is
  // as fresh as possible — defensive against any race where the
  // record was first seen before the buyer finished locking all
  // their leaves.
  {
    const fresh = await queryPendingHtlcs(wallet, {
      role: 'receiver',
      paymentHashes: [paymentHash],
      status: 'waiting',
      limit: 5,
    });
    if (fresh.length === 0) {
      state.phase = 'failed';
      state.cause = 'buyer lock disappeared between detection and validation';
      state.message = state.cause;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      return { outcome: 'failed', state };
    }
    const totalLocked = fresh.reduce((acc, r) => acc + r.lockedSats, 0);
    if (totalLocked < params.expectedSatsFromBuyer) {
      state.phase = 'failed';
      state.cause =
        `buyer locked ${totalLocked} sats but order required ${params.expectedSatsFromBuyer} — ` +
        `refusing to reveal preimage. Our asset lock will refund automatically at expiry.`;
      state.message = state.cause;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      return { outcome: 'failed', state };
    }
    // Log the over/exact-pay so it's visible in the swap log.
    if (totalLocked > params.expectedSatsFromBuyer) {
      state.message =
        `buyer overpaid: locked ${totalLocked} sats for ${params.expectedSatsFromBuyer}-sat order. ` +
        `Accepting and revealing preimage.`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
    }
  }

  // Phase 3: reveal preimage. `revealAndClaim` only BROADCASTS the
  // preimage to the coordinator — the actual leaf claim is async on the
  // SDK side. We need to verify it lands before declaring the swap
  // completed; otherwise the caller (swapRunner) would fire the
  // settlement auto-emit on an unfinished trade and the seller would
  // give the asset away without receiving sats.
  //
  // Snapshot the available balance just before the reveal so the
  // post-reveal poll can detect the delta arriving. Use the freshness-
  // guaranteed `getBalance` (not the in-memory cache).
  const sdkWallet = wallet as { getBalance: () => Promise<{ balance: bigint }> };
  let balanceBefore: bigint;
  try {
    const r = await sdkWallet.getBalance();
    balanceBefore = r.balance;
  } catch (e) {
    state.phase = 'failed';
    state.cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    state.message = `pre-reveal balance snapshot failed: ${state.cause}`;
    state.updatedAt = nowIso();
    params.onState({ ...state });
    return { outcome: 'failed', state };
  }

  state.phase = 'revealing';
  state.message = `revealing preimage to claim counterparty's ${params.expectedSatsFromBuyer} sat(s)`;
  state.updatedAt = nowIso();
  params.onState({ ...state });

  try {
    await revealAndClaim(wallet, preimage);
  } catch (e) {
    state.phase = 'failed';
    state.cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    state.message = `revealAndClaim failed: ${state.cause}`;
    state.updatedAt = nowIso();
    params.onState({ ...state });
    return { outcome: 'failed', state };
  }

  state.revealedPreimageHex = bytesToHex(preimage);

  // Phase 3.5: poll until the claim actually lands (our balance increases
  // by expectedSatsFromBuyer) or the verify window elapses. The SDK
  // documents `getBalance().balance` as the fresh-from-coordinator value,
  // so each poll is authoritative.
  state.phase = 'awaiting-claim';
  state.message = `preimage revealed; awaiting claim of buyer's ${params.expectedSatsFromBuyer} sat(s) to land`;
  state.updatedAt = nowIso();
  params.onState({ ...state });

  const claimDeadline = Date.now() + DEFAULT_CLAIM_VERIFY_MS;
  const expectedSatsBig = BigInt(params.expectedSatsFromBuyer);
  let claimVerified = false;
  while (Date.now() < claimDeadline) {
    let balanceNow: bigint;
    try {
      const r = await sdkWallet.getBalance();
      balanceNow = r.balance;
    } catch {
      // Transient balance query failure; keep polling.
      await sleep(pollInterval);
      continue;
    }
    if (balanceNow >= balanceBefore + expectedSatsBig) {
      claimVerified = true;
      break;
    }
    await sleep(pollInterval);
  }

  if (!claimVerified) {
    state.phase = 'reveal-without-claim';
    state.cause =
      `preimage public but claim of ${params.expectedSatsFromBuyer} sat(s) did not land within ` +
      `${Math.round(DEFAULT_CLAIM_VERIFY_MS / 1000)}s. Buyer can still claim our asset off the public ` +
      `preimage; the trade is atomically broken on our side. NOT emitting a settlement consignment.`;
    state.message = state.cause;
    state.updatedAt = nowIso();
    params.onState({ ...state });
    return { outcome: 'reveal-without-claim', state };
  }

  state.phase = 'completed';
  state.message = `swap completed — preimage revealed, ${params.expectedSatsFromBuyer} sat(s) claimed`;
  state.updatedAt = nowIso();
  params.onState({ ...state });
  return { outcome: 'completed', state };
}

/**
 * Resume a buyer flow whose lock is already in place in the coordinator
 * (e.g., a previous attempt completed the lock step before the UI was
 * reloaded or the user re-clicked Run swap). Skips the leaf-selection +
 * `lockUnderHash` call entirely — useful when the wallet's available
 * leaves no longer include one sufficient for `priceSats` because the
 * sufficient leaf IS the one already locked in the active HTLC.
 *
 * The caller is responsible for verifying via `queryPendingHtlcs` that a
 * sender-role lock for this paymentHash is actually active before invoking
 * this function. If no lock is in place, the polling loop will eventually
 * time out at `expiryTime` and return `expired`.
 */
export async function resumeBuyerFlow(
  wallet: unknown,
  params: {
    paymentHash: Uint8Array;
    counterpartyPubkey: Uint8Array;
    expiryTime: Date;
    pollIntervalMs?: number;
    onState: StateCallback;
  },
): Promise<FlowResult> {
  const paymentHashHex = bytesToHex(params.paymentHash);
  const pollInterval = params.pollIntervalMs ?? DEFAULT_POLL_MS;

  const state: SwapState = {
    phase: 'locked',
    paymentHashHex,
    message: 'resumed: existing lock confirmed in coordinator state',
    updatedAt: nowIso(),
    ourExpiry: params.expiryTime,
  };
  params.onState({ ...state });
  state.phase = 'awaiting-counterparty';
  params.onState({ ...state });

  let revealed: Uint8Array | null = null;
  while (Date.now() < params.expiryTime.getTime()) {
    try {
      revealed = await queryRevealedPreimage(wallet, params.paymentHash, params.counterpartyPubkey);
    } catch (e) {
      state.message = `query_preimage error (will retry): ${e instanceof Error ? e.message : String(e)}`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      await sleep(pollInterval);
      continue;
    }
    if (revealed) {
      state.message = `seller revealed preimage`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      break;
    }
    await sleep(pollInterval);
  }

  if (!revealed) {
    state.phase = 'expired';
    state.message = `our lock expired before seller revealed — sats refund automatically`;
    state.updatedAt = nowIso();
    params.onState({ ...state });
    return { outcome: 'expired', state };
  }

  return claimAndVerifyLeaf(wallet, revealed, state, params.onState, pollInterval);
}

/** Shared post-reveal helper for buyer flows (runBuyerFlow + resumeBuyerFlow).
 *  Snapshots the wallet's leaf-id set, calls revealAndClaim, then polls
 *  for a new leaf to materialize. Returns the new leaf's id so the
 *  caller can pin the RGB rebind to it. */
async function claimAndVerifyLeaf(
  wallet: unknown,
  revealed: Uint8Array,
  state: SwapState,
  onState: StateCallback,
  pollInterval: number,
): Promise<FlowResult> {
  const sdkWallet = wallet as {
    getLeaves: (b?: boolean) => Promise<Array<{ id: string }>>;
  };
  let leafIdsBefore: Set<string>;
  try {
    const before = await sdkWallet.getLeaves(true);
    leafIdsBefore = new Set(before.map((l) => l.id));
  } catch (e) {
    state.phase = 'failed';
    state.cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    state.message = `pre-claim leaves snapshot failed: ${state.cause}`;
    state.updatedAt = nowIso();
    onState({ ...state });
    return { outcome: 'failed', state };
  }

  state.phase = 'revealing';
  state.message = `claiming asset with discovered preimage`;
  state.updatedAt = nowIso();
  onState({ ...state });

  try {
    await revealAndClaim(wallet, revealed);
  } catch (e) {
    state.phase = 'failed';
    state.cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    state.message = `revealAndClaim failed: ${state.cause}`;
    state.updatedAt = nowIso();
    onState({ ...state });
    return { outcome: 'failed', state };
  }

  state.revealedPreimageHex = bytesToHex(revealed);
  state.phase = 'awaiting-claim';
  state.message = `preimage applied; awaiting claimed leaf to land`;
  state.updatedAt = nowIso();
  onState({ ...state });

  const claimDeadline = Date.now() + DEFAULT_CLAIM_VERIFY_MS;
  let claimedLeafId: string | undefined;
  while (Date.now() < claimDeadline) {
    let after: Array<{ id: string }>;
    try {
      after = await sdkWallet.getLeaves(true);
    } catch {
      await sleep(pollInterval);
      continue;
    }
    const newOnes = after.filter((l) => !leafIdsBefore.has(l.id));
    if (newOnes.length > 0) {
      claimedLeafId = newOnes[0].id;
      break;
    }
    await sleep(pollInterval);
  }

  if (!claimedLeafId) {
    state.phase = 'failed';
    state.cause =
      `preimage applied but no new leaf arrived within ` +
      `${Math.round(DEFAULT_CLAIM_VERIFY_MS / 1000)}s. SDK may be stuck — ` +
      `our sats lock will refund at expiry. Don't trust any RGB consignment ` +
      `arriving for this trade since we have no leaf to bind it to.`;
    state.message = state.cause;
    state.updatedAt = nowIso();
    onState({ ...state });
    return { outcome: 'failed', state };
  }

  state.phase = 'completed';
  state.message = `swap completed — asset claimed from seller (leaf ${claimedLeafId.slice(0, 8)}…)`;
  state.updatedAt = nowIso();
  onState({ ...state });
  return { outcome: 'completed', state, claimedLeafId };
}

/**
 * Buyer-side flow. Given the seller's already-published `paymentHash`
 * (from the orderbook), locks our sats to the seller, polls until the
 * seller reveals the preimage, then claims the seller's asset.
 *
 * The buyer must verify the seller's lock is in place under `paymentHash`
 * with this wallet as receiver BEFORE calling this — that's a precondition
 * outside this function's scope (UI / orderbook layer does it).
 */
export async function runBuyerFlow(
  wallet: unknown,
  params: {
    /** Our sat leaves to give up to the seller. */
    satsLeaves: TreeNode[];
    /** Counterparty's Spark identity pubkey. */
    counterpartyPubkey: Uint8Array;
    /** Hash published by the seller in the orderbook. */
    paymentHash: Uint8Array;
    /** Our lock's expiry (T_B). Must be < seller's T_A − safety margin. */
    expiryTime: Date;
    pollIntervalMs?: number;
    onState: StateCallback;
  },
): Promise<FlowResult> {
  const paymentHashHex = bytesToHex(params.paymentHash);
  const pollInterval = params.pollIntervalMs ?? DEFAULT_POLL_MS;

  const state: SwapState = {
    phase: 'preparing',
    paymentHashHex,
    message: 'preparing buyer-side lock',
    updatedAt: nowIso(),
    ourExpiry: params.expiryTime,
  };
  params.onState({ ...state });

  // Phase 1: lock our sats to the seller.
  // Resumability: same ALREADY_EXISTS handling as seller-side — see comment
  // there. Lets the user re-click Run swap after a UI reload without
  // double-locking.
  state.phase = 'locking';
  state.message = `locking ${params.satsLeaves.length} sat leaf(es) under H to seller`;
  state.updatedAt = nowIso();
  params.onState({ ...state });
  try {
    await lockUnderHash(wallet, {
      leaves: params.satsLeaves,
      recipientIdentityPubkey: params.counterpartyPubkey,
      paymentHash: params.paymentHash,
      expiryTime: params.expiryTime,
    });
  } catch (e) {
    const errStr = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (errStr.includes('ALREADY_EXISTS')) {
      state.message = `lock already in place from a previous attempt — resuming`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
    } else {
      state.phase = 'failed';
      state.cause = errStr;
      state.message = `lockUnderHash failed: ${state.cause}`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      return { outcome: 'failed', state };
    }
  }

  state.phase = 'locked';
  state.message = `sats locked under H; polling for seller's reveal`;
  state.updatedAt = nowIso();
  params.onState({ ...state });
  state.phase = 'awaiting-counterparty';
  params.onState({ ...state });

  // Phase 2: poll queryRevealedPreimage until we see the seller's reveal,
  // OR our own lock expires.
  let revealed: Uint8Array | null = null;
  while (Date.now() < params.expiryTime.getTime()) {
    try {
      revealed = await queryRevealedPreimage(wallet, params.paymentHash, params.counterpartyPubkey);
    } catch (e) {
      state.message = `query_preimage error (will retry): ${e instanceof Error ? e.message : String(e)}`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      await sleep(pollInterval);
      continue;
    }
    if (revealed) {
      state.message = `seller revealed preimage`;
      state.updatedAt = nowIso();
      params.onState({ ...state });
      break;
    }
    await sleep(pollInterval);
  }

  if (!revealed) {
    state.phase = 'expired';
    state.message = `our lock expired before seller revealed — sats refund automatically`;
    state.updatedAt = nowIso();
    params.onState({ ...state });
    return { outcome: 'expired', state };
  }

  return claimAndVerifyLeaf(wallet, revealed, state, params.onState, pollInterval);
}

// ----- Re-exported helpers -------------------------------------------------

export { bytesToHex, hexToBytes };
