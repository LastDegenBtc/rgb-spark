// Wrapper around @buildonspark/spark-sdk — single source of truth for the
// Spark-side of the wallet. Keeps one singleton per browser tab.
//
// Seed: passed as raw bytes (the user's Nostr privkey — see lib/nostrKey.ts
// for the unified-seed rationale). Spark accepts a Uint8Array for
// `mnemonicOrSeed` and runs its own HD derivation on top.

import { SparkWallet } from '@buildonspark/spark-sdk';

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
