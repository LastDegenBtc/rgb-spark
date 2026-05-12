// Wrapper around @buildonspark/spark-sdk — single source of truth for the
// Spark-side of the wallet. Keeps one singleton per browser tab.
//
// Seed: passed as raw bytes (the user's Nostr privkey — see lib/nostrKey.ts
// for the unified-seed rationale). Spark accepts a Uint8Array for
// `mnemonicOrSeed` and runs its own HD derivation on top.

import { SparkWallet, KeyDerivationType } from '@buildonspark/spark-sdk';
import type { SparkSigner } from '@buildonspark/spark-sdk';
import { setPathTweak, clearPathTweak } from './rgbAwareSigner';

type Network = 'MAINNET' | 'REGTEST' | 'TESTNET';

let walletInstance: SparkWallet | null = null;
let initPromise: Promise<SparkWallet> | null = null;
let initSeedHash: string | null = null;
let currentNetwork: Network | null = null;

async function hashSeed(seed: Uint8Array): Promise<string> {
  // Copy into a fresh Uint8Array<ArrayBuffer> — crypto.subtle.digest's TS
  // signature rejects Uint8Array<ArrayBufferLike> (which could be backed by a
  // SharedArrayBuffer); the copy guarantees a plain ArrayBuffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(seed).buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
}

export interface WalletInitResult {
  wallet: SparkWallet;
  sparkAddress: string;
  depositAddress: string;
  identityPubkey: string;
  network: Network;
}

export async function initSparkWallet(
  seed: Uint8Array,
  network: Network = 'MAINNET',
  signer?: SparkSigner,
): Promise<WalletInitResult> {
  const seedHash = await hashSeed(seed);
  if (walletInstance && initSeedHash === seedHash && currentNetwork === network) {
    return buildResult(walletInstance, network);
  }
  if (initPromise) {
    await initPromise;
    return buildResult(walletInstance!, network);
  }

  initPromise = (async () => {
    if (walletInstance) {
      await disposeSparkWallet();
    }
    const { wallet } = await SparkWallet.initialize({
      mnemonicOrSeed: seed,
      signer,
      options: { network },
    });
    walletInstance = wallet;
    initSeedHash = seedHash;
    currentNetwork = network;
    return wallet;
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
  return buildResult(walletInstance!, network);
}

async function buildResult(wallet: SparkWallet, network: Network): Promise<WalletInitResult> {
  const [sparkAddress, depositAddress, identityPubkey] = await Promise.all([
    wallet.getSparkAddress(),
    wallet.getSingleUseDepositAddress(),
    wallet.getIdentityPublicKey().then((pk) =>
      typeof pk === 'string'
        ? pk
        : Array.from(pk as Uint8Array).map((b) => b.toString(16).padStart(2, '0')).join(''),
    ),
  ]);
  return { wallet, sparkAddress, depositAddress, identityPubkey, network };
}

export function getSparkWallet(): SparkWallet | null {
  return walletInstance;
}

export async function getBalance(): Promise<bigint> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const { balance } = await walletInstance.getBalance();
  return balance;
}

export class SparkTransferTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Spark SDK did not respond within ${Math.round(timeoutMs / 1000)} s — try a different browser (Brave iOS / WKWebView is known to hang on the SDK's gRPC streams).`);
    this.name = 'SparkTransferTimeoutError';
  }
}

/**
 * Sends sats to another Spark address (used for trading-account deposits).
 * Returns the transferId — caller hands it to the server's claim endpoint.
 *
 * Wraps the SDK call in a timeout: in production we've seen the underlying
 * `wallet.transfer()` hang indefinitely on Brave iOS / WKWebView (its gRPC
 * stream blocks without ever resolving or rejecting). Without this race the
 * UI sits on a forever-spinning "Paying…" with no escape.
 */
export async function transferToSpark(
  amountSats: number,
  receiverSparkAddress: string,
  timeoutMs = 30_000,
): Promise<string> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SparkTransferTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    const result = await Promise.race([
      walletInstance.transfer({ amountSats, receiverSparkAddress }),
      timeoutPromise,
    ]);
    return result.id;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ----- Leaves ----------------------------------------------------------------

export interface SparkLeafRow {
  id: string;
  treeId: string;
  value: number;
  status: string;
  network: string;
  // Per-leaf signing pubkey — this is the leaf-scoped `u_base` candidate for
  // a SparkUtkProof. NOT to be confused with the wallet-wide identityPubkey.
  ownerSigningPublicKey: string;
  // Aggregated FROST pubkey held by the SE operators responsible for this leaf.
  // Goes into the proof's `operator` field.
  operatorPublicKey: string;
  // The leaf's own verifying key. For a vanilla (non-RGB) leaf with msg=0 the
  // Spark-UTK relation collapses to:
  //   verifyingPublicKey == ownerSigningPublicKey + operatorPublicKey
  // which is what gives the receiver a math-checkable binding.
  verifyingPublicKey: string;
}

function bytesToHex(u: Uint8Array | undefined): string {
  if (!u || u.length === 0) return '';
  let out = '';
  for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, '0');
  return out;
}

export async function listSparkLeaves(): Promise<SparkLeafRow[]> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const leaves = await walletInstance.getLeaves(true);
  return leaves.map((leaf) => ({
    id: String(leaf.id),
    treeId: String(leaf.treeId),
    value: Number(leaf.value ?? 0),
    status: String(leaf.status ?? ''),
    network: String(leaf.network ?? ''),
    ownerSigningPublicKey: bytesToHex(leaf.ownerSigningPublicKey as Uint8Array),
    operatorPublicKey: bytesToHex(leaf.signingKeyshare?.publicKey as Uint8Array | undefined),
    verifyingPublicKey: bytesToHex(leaf.verifyingPublicKey as Uint8Array),
  }));
}

// ----- History ---------------------------------------------------------------

export interface SparkTransferRow {
  id: string;
  amountSats: number;
  direction: 'in' | 'out';
  status: string;
  type: string;             // TRANSFER, PREIMAGE_SWAP (lightning), COOPERATIVE_EXIT (L1 exit), …
  counterparty: string;     // short id for display (sender or receiver pubkey)
  createdAt: string | null;
}

export async function listSparkTransfers(limit = 20): Promise<SparkTransferRow[]> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const myPk = await walletInstance.getIdentityPublicKey();
  const myPkHex = typeof myPk === 'string'
    ? myPk
    : Array.from(myPk as Uint8Array).map((b) => b.toString(16).padStart(2, '0')).join('');
  const page = await walletInstance.getTransfers(limit, 0);
  return (page.transfers ?? []).map((t) => {
    const dirRaw = String((t as unknown as { transferDirection?: string }).transferDirection ?? '');
    const direction: 'in' | 'out' = /incoming/i.test(dirRaw) ? 'in' : 'out';
    const sender = String((t as unknown as { senderIdentityPublicKey?: string }).senderIdentityPublicKey ?? '');
    const receiver = String((t as unknown as { receiverIdentityPublicKey?: string }).receiverIdentityPublicKey ?? '');
    const counterRaw = direction === 'in'
      ? sender
      : (receiver && receiver.toLowerCase() !== myPkHex.toLowerCase() ? receiver : '');
    return {
      id: String(t.id),
      amountSats: Number((t as unknown as { totalValue?: number | string }).totalValue ?? 0),
      direction,
      status: String((t as unknown as { status?: string }).status ?? ''),
      type: String((t as unknown as { type?: string }).type ?? ''),
      counterparty: counterRaw ? counterRaw.slice(0, 10) + '…' + counterRaw.slice(-4) : '—',
      // SDK exposes createdTime as a Date object; serialize defensively.
      createdAt: (() => {
        const ct = (t as unknown as { createdTime?: Date | string; createdAt?: string }).createdTime
          ?? (t as unknown as { createdAt?: string }).createdAt
          ?? null;
        if (!ct) return null;
        if (ct instanceof Date) return ct.toISOString();
        return String(ct);
      })(),
    };
  });
}

// ----- Lightning -------------------------------------------------------------

export interface CreatedInvoice {
  id: string;
  encodedInvoice: string;
  amountSats: number;
  expiresAt: string;
  memo?: string;
}

export async function createLightningInvoice(opts: {
  amountSats: number;
  memo?: string;
  expirySeconds?: number;
}): Promise<CreatedInvoice> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const req = await walletInstance.createLightningInvoice(opts);
  return {
    id: req.id,
    encodedInvoice: req.invoice.encodedInvoice,
    amountSats: opts.amountSats,
    expiresAt: req.invoice.expiresAt,
    memo: req.invoice.memo,
  };
}

export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'unknown';

// Spark exposes ~10 receive-request status values; bucket them into the three
// the UI cares about. INVOICE_CREATED is the only "still waiting" state — any
// of the post-payment intermediate states (transfer-created, preimage-recovered,
// transfer-completed, lightning-payment-received) means the sats arrived.
export async function getInvoiceStatus(id: string): Promise<InvoiceStatus> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const req = await walletInstance.getLightningReceiveRequest(id);
  if (!req) return 'unknown';
  const s = String(req.status);
  if (s === 'INVOICE_CREATED') return 'pending';
  if (s.endsWith('_FAILED')) return 'failed';
  return 'paid';
}

export async function estimateLightningFee(invoice: string, amountSats?: number): Promise<number | null> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  try {
    return await walletInstance.getLightningSendFeeEstimate({ encodedInvoice: invoice, amountSats });
  } catch {
    return null;
  }
}

export async function payLightningInvoice(opts: {
  invoice: string;
  maxFeeSats: number;
  amountSatsToSend?: number;
}): Promise<void> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  await walletInstance.payLightningInvoice(opts);
}

// ----- L1 deposits -----------------------------------------------------------

// Single-use deposit addresses (getSingleUseDepositAddress) do NOT auto-sweep.
// After the funding tx confirms, the user must call claimDeposit(txid) once,
// or the sats stay on L1 indefinitely. The UI exposes both helpers below so
// the recovery path is reachable from the Wallet page.

export async function getUnusedDepositAddresses(): Promise<string[]> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const fn = (walletInstance as unknown as {
    getUnusedDepositAddresses?: () => Promise<string[]>;
  }).getUnusedDepositAddresses;
  if (!fn) return [];
  return fn.call(walletInstance);
}

export interface ClaimL1Result {
  totalSats: number;
  leafCount: number;
}

export async function claimL1Deposit(txid: string): Promise<ClaimL1Result> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  const leaves = await walletInstance.claimDeposit(txid);
  const totalSats = leaves.reduce((sum, l) => sum + Number(l.value ?? 0), 0);
  return { totalSats, leafCount: leaves.length };
}

// ----- Spark-UTK mint via self-transfer (chunk-α-bis rev v2) -----------------
//
// Why this exists: tweaking during `claimDeposit` is rejected by the SE
// because the L1 P2TR scriptPubKey commits to U_base — see
// project_spark_deposit_owner_check.md. The only safe place to apply a
// Spark-UTK tweak is the *receiver side of a Spark→Spark transfer*, where
// the destination signing pubkey is not L1-pinned and the SE persists
// whatever we declare.
//
// To make this work without touching the SDK source we:
//   1. Send to our own sparkAddress via `transferService.sendTransferV3`
//      with the signer's pathTweaks empty (source leaf must sign vanilla).
//   2. Add `leafId → msg` to pathTweaks.
//   3. Manually call `transferService.claimTransfer` — during the claim's
//      `newKeyDerivation = { LEAF, path: leafId }` lookup, the signer sees
//      the path is tweaked and returns U_tweaked. The SE persists the new
//      leaf with `verifyingPublicKey = U_tweaked + operator`.
//   4. Remove the path from pathTweaks immediately.
//
// We bypass `walletInstance.transfer` because that method bundles send+claim
// inline for self-transfers and we need to interpose pathTweaks state
// between the two phases. `transferService` is protected on the wallet, but
// JS visibility doesn't enforce it — we cast through `unknown`.

export interface MintViaSelfTransferResult {
  transferId: string;
  leaf: SparkLeafRow;
}

// Minimal shape of a Spark TreeNode (SDK type) we need from the claim's
// return value. Everything is bytes/strings off the proto.
interface SparkClaimedNode {
  id: string;
  value: number;
  network: string;
  ownerSigningPublicKey: Uint8Array;
  verifyingPublicKey: Uint8Array;
  signingKeyshare?: { publicKey?: Uint8Array };
}

interface SparkWalletInternals {
  transferService: {
    sendTransferV3: (leaves: unknown[]) => Promise<{ id: string }>;
    queryTransfer: (transferId: string) => Promise<unknown>;
    claimTransfer: (transfer: unknown) => Promise<unknown>;
  };
  // Private on the wallet but accessible at runtime. We use it because it
  // (a) wraps the SDK claim in a mutex, (b) returns the new TreeNodes directly
  // from processClaimedTransferResults, which is critical: listSparkLeaves()
  // re-queries the SE and applies a verifyKey filter that drops our tweaked
  // leaf (its persisted pubkey doesn't match a vanilla HD derivation from
  // the new leaf id). The claim's return value is the only place we see the
  // freshly-minted tweaked leaf without that filter.
  claimTransfer: (opts: { transfer: unknown; emit?: boolean }) => Promise<SparkClaimedNode[]>;
}

export async function mintViaSelfTransfer(
  leafId: string,
  msgBytes: Uint8Array,
): Promise<MintViaSelfTransferResult> {
  if (!walletInstance) throw new Error('Wallet not initialized');
  if (msgBytes.length !== 32) {
    throw new Error(`mint msg must be 32 bytes, got ${msgBytes.length}`);
  }

  const allLeaves = await walletInstance.getLeaves(true);
  const sourceLeaf = allLeaves.find((l) => String(l.id) === leafId);
  if (!sourceLeaf) {
    throw new Error(`leaf ${leafId} not found in wallet`);
  }

  // wallet.getIdentityPublicKey() returns a hex string; the SDK's internal
  // LeafKeyTweak expects a 33-byte Uint8Array. Decode here.
  const identityPubkeyHex = await walletInstance.getIdentityPublicKey();
  if (identityPubkeyHex.length !== 66) {
    throw new Error(`identityPubkey must be 33 bytes (66 hex), got ${identityPubkeyHex.length} hex chars`);
  }
  const identityPubkey = new Uint8Array(33);
  for (let i = 0; i < 33; i++) {
    identityPubkey[i] = parseInt(identityPubkeyHex.substr(i * 2, 2), 16);
  }

  const internals = walletInstance as unknown as SparkWalletInternals;
  const transferService = internals.transferService;
  if (!transferService) {
    throw new Error('transferService not accessible on walletInstance');
  }

  // 1. Send phase — pathTweaks empty, source signs vanilla.
  const leafKeyTweak = {
    leaf: sourceLeaf,
    keyDerivation: { type: KeyDerivationType.LEAF, path: leafId },
    newKeyDerivation: { type: KeyDerivationType.RANDOM },
    receiverIdentityPublicKey: identityPubkey,
  };
  const transfer = await transferService.sendTransferV3([leafKeyTweak]);

  // 2. Self-referencing tweak — during the claim, the SDK calls the signer
  //    with newKeyDerivation = {LEAF, path: leafId}, where leafId is the
  //    SOURCE leaf id (not the new one yet, which the SE only assigns later).
  //    A self-ref entry (sourcePath == currentLeafId) makes the signer return
  //    U_tweaked at that moment.
  setPathTweak(leafId, leafId, msgBytes);
  let claimedNodes: SparkClaimedNode[];
  try {
    const pending = await transferService.queryTransfer(transfer.id);
    if (!pending) {
      throw new Error(`pending transfer ${transfer.id} not found after sendTransferV3`);
    }
    claimedNodes = await internals.claimTransfer({ transfer: pending, emit: false });
  } finally {
    // Always drop the self-ref so future getLeaves()/sync() asking for the
    // source leaf's path returns vanilla. (The source leaf is spent anyway,
    // but defensive — the SDK may still query that path during ack flows.)
    clearPathTweak(leafId);
  }

  if (claimedNodes.length === 0) {
    throw new Error(`claimTransfer returned no nodes for source ${leafId}`);
  }
  // For a single-leaf self-transfer there should be exactly one new node.
  const expectedValue = Number(sourceLeaf.value ?? 0);
  const newNode =
    claimedNodes.find((n) => n.value === expectedValue) ?? claimedNodes[0];

  // 3. Indirect persistent entry — for every future getPublicKeyFromDerivation
  //    or getSigningPrivateKeyFromDerivation on the NEW leaf id, the signer
  //    must return U_tweaked. Bind the new id back to the original sourcePath
  //    so it can re-derive the base, then apply the same msg.
  setPathTweak(String(newNode.id), leafId, msgBytes);

  const newLeaf: SparkLeafRow = {
    id: String(newNode.id),
    treeId: String((newNode as unknown as { treeId?: string }).treeId ?? ''),
    value: Number(newNode.value ?? 0),
    status: String((newNode as unknown as { status?: string }).status ?? ''),
    network: String(newNode.network ?? ''),
    ownerSigningPublicKey: bytesToHex(newNode.ownerSigningPublicKey),
    operatorPublicKey: bytesToHex(newNode.signingKeyshare?.publicKey),
    verifyingPublicKey: bytesToHex(newNode.verifyingPublicKey),
  };

  return { transferId: transfer.id, leaf: newLeaf };
}

export async function disposeSparkWallet(): Promise<void> {
  if (!walletInstance) return;
  try {
    await (walletInstance as unknown as { cleanupConnections?: () => Promise<void> })
      .cleanupConnections?.();
  } catch {
    /* best-effort */
  }
  walletInstance = null;
  initSeedHash = null;
  currentNetwork = null;
}
