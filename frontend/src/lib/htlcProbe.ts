// HTLC unlock probe — Phase 1C R&D session 0.
//
// Goal: determine whether Spark's `swapNodesForPreimage` accepts a call
// without a valid Lightning bolt11 invoice. If yes, we have access to an
// HTLC primitive usable for P2P atomic swap. If no, the error message
// tells us exactly what the coordinator validates, narrowing the search
// for a trustless atomic primitive.
//
// What this probe does:
//   1. Picks a leaf the user designated (smallest available, see UI).
//   2. Generates a random preimage P and paymentHash H = sha256(P).
//   3. Calls `swapNodesForPreimage` with `isInboundPayment: false`,
//      `receiverIdentityPubkey` = our own (self-swap so the destination
//      is moot for the probe), and one of three invoice shapes per call:
//        - `empty`: invoiceString = "" (default branch in SDK)
//        - `garbage`: invoiceString = "lnbc1pgarbage" (non-decodable bech32)
//        - `forged`: TODO — requires bolt11 encoder, deferred until
//          stages 1+2 narrow what the coordinator validates.
//   4. Captures the coordinator's response or error verbatim.
//   5. If the probe SUCCEEDS (unexpected at stages 1+2), immediately
//      calls `providePreimage(P)` to unlock the leaf, leaving wallet
//      state unchanged. Otherwise nothing is committed — the SDK call
//      failed before any leaf-tweak happened.
//
// Risk: at stages 1+2 we expect the coordinator to reject. If it
// unexpectedly accepts, the leaf is locked under H. `providePreimage`
// should release it; if even that fails, the leaf stays locked until
// `expiryTime` (60s).

import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { KeyDerivationType } from '@buildonspark/spark-sdk';
import type { TreeNode } from '@buildonspark/spark-sdk/proto/spark';

// The SDK's `swapNodesForPreimage` consumes a list of `LeafKeyTweak`, not raw
// TreeNodes. LeafKeyTweak.leaf is the TreeNode; the wrapper carries the source
// and destination derivation paths plus the receiver identity. Same shape we
// already use in `mintViaSelfTransfer`.
interface LeafKeyTweakShape {
  leaf: TreeNode;
  keyDerivation: { type: KeyDerivationType; path?: string };
  newKeyDerivation: { type: KeyDerivationType; path?: string };
  receiverIdentityPublicKey: Uint8Array;
}

type HtlcServiceAccess = {
  swapNodesForPreimage: (params: {
    leaves: LeafKeyTweakShape[];
    receiverIdentityPubkey: Uint8Array;
    paymentHash: Uint8Array;
    invoiceString?: string;
    isInboundPayment: boolean;
    feeSats?: number;
    amountSatsToSend?: number;
    expiryTime: Date;
  }) => Promise<unknown>;
  providePreimage: (preimage: Uint8Array) => Promise<unknown>;
};

type WalletWithLightning = {
  config: { signer: { getIdentityPublicKey: () => Promise<Uint8Array> } };
  lightningService: HtlcServiceAccess;
  getLeaves: (isBalanceCheck?: boolean) => Promise<TreeNode[]>;
};

export type InvoiceShape = 'empty' | 'garbage';

// Probe 2 — verifies the read-back path after providePreimage. After the
// coordinator accepts our swap and `providePreimage(P)` unlocks the leaf,
// we want to confirm that:
//   (a) `query_preimage({paymentHash, receiverIdentityPubkey})` returns P
//       — the API Bob would use to discover the secret after Alice reveals.
//   (b) `query_htlc(...)` returns the HTLC record with status PREIMAGE_SHARED
//       — the API Bob would use to enumerate his pending HTLCs.
export interface HtlcRevealProbeResult {
  leafId: string;
  leafValueSats: number;
  paymentHashHex: string;
  preimageHex: string;
  swapAccepted: boolean;
  swapError?: string;
  unlockAccepted?: boolean;
  unlockError?: string;
  queryPreimageReturnedSameP?: boolean;
  queryPreimageReturnedRaw?: string;
  queryPreimageError?: string;
  queryHtlcStatus?: string;
  queryHtlcCount?: number;
  queryHtlcError?: string;
  elapsedMs: number;
}

export interface HtlcProbeResult {
  shape: InvoiceShape;
  invoiceString: string;
  leafId: string;
  leafValueSats: number;
  paymentHashHex: string;
  /** True if `swapNodesForPreimage` returned without throwing. Indicates the
   *  coordinator accepted the call — the leaf is now locked under
   *  paymentHash. We immediately try `providePreimage` to unlock. */
  swapAccepted: boolean;
  /** Verbatim message from the coordinator's error response, if the swap
   *  was rejected. This is the diagnostic — it tells us what the
   *  coordinator validated. */
  swapError?: string;
  /** True if `providePreimage` returned the leaf to us. Only meaningful
   *  when `swapAccepted` is true. */
  unlockAccepted?: boolean;
  unlockError?: string;
  /** Full ms timing from probe start to result, for diagnostic noise. */
  elapsedMs: number;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

const GARBAGE_INVOICE = 'lnbc1pgarbagez'; // bech32-shaped but undecodable as bolt11

/**
 * Run a single HTLC probe with the given invoice shape. The caller is
 * responsible for picking which leaf to risk (smallest available
 * recommended).
 */
export async function probeHtlc(
  wallet: unknown,
  leaf: TreeNode,
  shape: InvoiceShape,
): Promise<HtlcProbeResult> {
  const w = wallet as WalletWithLightning;
  const startedAt = Date.now();

  const preimage = randomBytes(32);
  const paymentHash = sha256(preimage);
  const identityPubkey = await w.config.signer.getIdentityPublicKey();

  const invoiceString = shape === 'empty' ? '' : GARBAGE_INVOICE;

  let swapAccepted = false;
  let swapError: string | undefined;
  let unlockAccepted: boolean | undefined;
  let unlockError: string | undefined;

  const leafKeyTweak: LeafKeyTweakShape = {
    leaf,
    keyDerivation: { type: KeyDerivationType.LEAF, path: leaf.id },
    newKeyDerivation: { type: KeyDerivationType.RANDOM },
    receiverIdentityPublicKey: identityPubkey,
  };

  try {
    await w.lightningService.swapNodesForPreimage({
      leaves: [leafKeyTweak],
      receiverIdentityPubkey: identityPubkey,
      paymentHash,
      invoiceString,
      isInboundPayment: false,
      expiryTime: new Date(Date.now() + 60_000),
    });
    swapAccepted = true;
  } catch (e) {
    swapError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (swapAccepted) {
    // Coordinator unexpectedly accepted the call. Try to unlock immediately
    // so the leaf isn't stuck until expiry. This is the path we'd LOVE to
    // hit at the forged-invoice stage — it means HTLC is exploitable.
    try {
      await w.lightningService.providePreimage(preimage);
      unlockAccepted = true;
    } catch (e) {
      unlockAccepted = false;
      unlockError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  }

  return {
    shape,
    invoiceString,
    leafId: leaf.id,
    leafValueSats: leaf.value,
    paymentHashHex: bytesToHex(paymentHash),
    swapAccepted,
    swapError,
    unlockAccepted,
    unlockError,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Probe 2 — lock + reveal + verify read-back of the preimage via the
 * coordinator. This is the test for "preimage observability": confirms
 * that after one party reveals P via `providePreimage`, another party can
 * retrieve P via `query_preimage` / `query_htlc`. We run both legs from
 * the same wallet (Alice = Bob = self) so the read-back queries hit a
 * valid `receiverIdentityPubkey`; the cross-receiver semantics are
 * inferred from the proto contract (`query_preimage` takes
 * `receiverIdentityPubkey` as a parameter, implying scope-by-receiver,
 * so a cross-party swap will work the same way once two real wallets are
 * involved).
 */
export async function probeHtlcReveal(
  wallet: unknown,
  leaf: TreeNode,
): Promise<HtlcRevealProbeResult> {
  const w = wallet as WalletWithLightning & {
    lightningService: HtlcServiceAccess & {
      connectionManager: {
        createSparkClient: (
          addr: string,
        ) => Promise<{
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
            preimageRequests: Array<{ status?: number }>;
            offset: number;
          }>;
        }>;
      };
      config: {
        getCoordinatorAddress: () => string;
        signer: { getIdentityPublicKey: () => Promise<Uint8Array> };
      };
    };
  };
  const startedAt = Date.now();

  const preimage = randomBytes(32);
  const paymentHash = sha256(preimage);
  const identityPubkey = await w.config.signer.getIdentityPublicKey();

  const leafKeyTweak: LeafKeyTweakShape = {
    leaf,
    keyDerivation: { type: KeyDerivationType.LEAF, path: leaf.id },
    newKeyDerivation: { type: KeyDerivationType.RANDOM },
    receiverIdentityPublicKey: identityPubkey,
  };

  const result: HtlcRevealProbeResult = {
    leafId: leaf.id,
    leafValueSats: leaf.value,
    paymentHashHex: bytesToHex(paymentHash),
    preimageHex: bytesToHex(preimage),
    swapAccepted: false,
    elapsedMs: 0,
  };

  try {
    await w.lightningService.swapNodesForPreimage({
      leaves: [leafKeyTweak],
      receiverIdentityPubkey: identityPubkey,
      paymentHash,
      invoiceString: '',
      isInboundPayment: false,
      expiryTime: new Date(Date.now() + 60_000),
    });
    result.swapAccepted = true;
  } catch (e) {
    result.swapError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  try {
    await w.lightningService.providePreimage(preimage);
    result.unlockAccepted = true;
  } catch (e) {
    result.unlockAccepted = false;
    result.unlockError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  const sparkClient = await w.lightningService.connectionManager.createSparkClient(
    w.lightningService.config.getCoordinatorAddress(),
  );

  try {
    const qr = await sparkClient.query_preimage({
      paymentHash,
      receiverIdentityPubkey: identityPubkey,
    });
    if (qr.preimage && qr.preimage.length === 32) {
      result.queryPreimageReturnedRaw = bytesToHex(qr.preimage);
      result.queryPreimageReturnedSameP = result.queryPreimageReturnedRaw === result.preimageHex;
    } else {
      result.queryPreimageReturnedRaw = qr.preimage ? bytesToHex(qr.preimage) : '(empty)';
      result.queryPreimageReturnedSameP = false;
    }
  } catch (e) {
    result.queryPreimageError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  try {
    const qh = await sparkClient.query_htlc({
      paymentHashes: [paymentHash],
      identityPublicKey: identityPubkey,
      limit: 10,
      offset: 0,
      transferIds: [],
      matchRole: 1, // PREIMAGE_REQUEST_ROLE_RECEIVER (1) per proto; default
    });
    result.queryHtlcCount = qh.preimageRequests.length;
    if (qh.preimageRequests.length > 0) {
      const s = qh.preimageRequests[0]?.status;
      result.queryHtlcStatus = typeof s === 'number' ? `status=${s}` : 'status=(unset)';
    }
  } catch (e) {
    result.queryHtlcError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/**
 * Probe 3 — cross-receiver lock + expiry auto-return. Locks the smallest
 * leaf under a fresh paymentHash with `receiverIdentityPublicKey` set to
 * a THROWAWAY pubkey (we don't hold the corresponding privkey, so we
 * cannot claim — by design). Expiry is set short (60 s). The probe then
 * waits past expiry, queries `query_htlc` as SENDER, and checks
 * `getLeaves()` to confirm the leaf returns to us automatically.
 *
 * What this proves:
 *   (a) `swapNodesForPreimage` accepts a `receiverIdentityPublicKey`
 *       that is NOT the caller's identity — confirming cross-party
 *       atomic swaps are not gated by sender == receiver.
 *   (b) Without `providePreimage`, the lock auto-expires and the leaf
 *       returns to the sender — confirming the refund path works
 *       without manual cancellation.
 *
 * Cost: 1 leaf (smallest) is locked for ~60 s. No fraud risk — the
 * throwaway pubkey is generated client-side, so nobody else can claim.
 */
export interface HtlcCrossExpiryProbeResult {
  leafId: string;
  leafValueSats: number;
  recipientPubkeyHex: string;
  paymentHashHex: string;
  swapAccepted: boolean;
  swapError?: string;
  /** Status returned by `query_htlc` AFTER expiry. 0 = WAITING, 1 = PREIMAGE_SHARED,
   *  2 = RETURNED. We expect 2 (RETURNED). */
  postExpiryStatus?: number;
  postExpiryStatusError?: string;
  /** True if `getLeaves()` returns a leaf with the same id as the one we
   *  locked, AFTER the expiry window. Confirms the leaf landed back in
   *  our wallet automatically. */
  leafBackInWallet?: boolean;
  leafBackError?: string;
  elapsedMs: number;
  waitedMs: number;
}

export async function probeHtlcCrossExpiry(
  wallet: unknown,
  leaf: TreeNode,
  onPhase: (phase: string) => void,
): Promise<HtlcCrossExpiryProbeResult> {
  const w = wallet as WalletWithLightning & {
    lightningService: HtlcServiceAccess & {
      connectionManager: {
        createSparkClient: (
          addr: string,
        ) => Promise<{
          query_htlc: (req: {
            paymentHashes: Uint8Array[];
            identityPublicKey: Uint8Array;
            status?: number;
            limit: number;
            offset: number;
            transferIds: string[];
            matchRole: number;
          }) => Promise<{
            preimageRequests: Array<{ status?: number }>;
            offset: number;
          }>;
        }>;
      };
      config: {
        getCoordinatorAddress: () => string;
        signer: { getIdentityPublicKey: () => Promise<Uint8Array> };
      };
    };
  };
  const startedAt = Date.now();

  const preimage = randomBytes(32);
  const paymentHash = sha256(preimage);
  const identityPubkey = await w.config.signer.getIdentityPublicKey();

  // Generate a throwaway recipient pubkey we explicitly DO NOT own. The
  // privkey is discarded after the public derivation, so the leaf is
  // unclaimable until expiry — exactly the test condition we want.
  const throwawayPriv = secp256k1.utils.randomPrivateKey();
  const recipientPubkey = secp256k1.getPublicKey(throwawayPriv, true);

  const leafKeyTweak: LeafKeyTweakShape = {
    leaf,
    keyDerivation: { type: KeyDerivationType.LEAF, path: leaf.id },
    newKeyDerivation: { type: KeyDerivationType.RANDOM },
    receiverIdentityPublicKey: recipientPubkey,
  };

  const result: HtlcCrossExpiryProbeResult = {
    leafId: leaf.id,
    leafValueSats: leaf.value,
    recipientPubkeyHex: bytesToHex(recipientPubkey),
    paymentHashHex: bytesToHex(paymentHash),
    swapAccepted: false,
    elapsedMs: 0,
    waitedMs: 0,
  };

  onPhase('locking to throwaway recipient');
  try {
    await w.lightningService.swapNodesForPreimage({
      leaves: [leafKeyTweak],
      receiverIdentityPubkey: recipientPubkey,
      paymentHash,
      invoiceString: '',
      isInboundPayment: false,
      expiryTime: new Date(Date.now() + 60_000),
    });
    result.swapAccepted = true;
  } catch (e) {
    result.swapError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  // Wait past expiry (60 s lock + 8 s buffer for the coordinator to
  // process the RETURNED state transition).
  const WAIT_MS = 68_000;
  onPhase(`locked OK — waiting ${WAIT_MS / 1000}s for expiry`);
  const waitStarted = Date.now();
  await new Promise((res) => setTimeout(res, WAIT_MS));
  result.waitedMs = Date.now() - waitStarted;

  onPhase('querying coordinator for post-expiry HTLC state');
  const sparkClient = await w.lightningService.connectionManager.createSparkClient(
    w.lightningService.config.getCoordinatorAddress(),
  );
  try {
    const qh = await sparkClient.query_htlc({
      paymentHashes: [paymentHash],
      identityPublicKey: identityPubkey,
      limit: 10,
      offset: 0,
      transferIds: [],
      matchRole: 1, // SENDER — we initiated the lock
    });
    if (qh.preimageRequests.length > 0) {
      result.postExpiryStatus = qh.preimageRequests[0]?.status;
    } else {
      result.postExpiryStatusError = 'no HTLC found after expiry (count=0)';
    }
  } catch (e) {
    result.postExpiryStatusError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  onPhase('checking wallet for refunded leaf');
  try {
    const leaves = await w.getLeaves(true);
    result.leafBackInWallet = leaves.some((l) => l.id === leaf.id);
  } catch (e) {
    result.leafBackError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  result.elapsedMs = Date.now() - startedAt;
  onPhase('done');
  return result;
}

/** Pick the smallest available leaf (to minimize risk if the probe locks). */
export async function pickSmallestLeaf(wallet: unknown): Promise<TreeNode | null> {
  const w = wallet as WalletWithLightning;
  const leaves = await w.getLeaves(true);
  if (leaves.length === 0) return null;
  return leaves.reduce((min, l) => (l.value < min.value ? l : min), leaves[0]);
}
