// Client wrapper around the rgb-spark relay's `/order/*` routes
// (Phase 1C session 3). Mirrors `consignmentRelay.ts` for default base
// URL + error shape, with BIP-340 schnorr signing of every POST.
//
// The server-side schema, validation rules, and matching policy live
// in `relay/src/orderbook.ts`. This module ships a typed client + a
// canonicalizer that must produce byte-identical output to the server's
// canonicalizer for signatures to verify (the server runs the same
// algorithm).

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { canonicalize } from './envelopeSign';

// ----- Wire types (kept in sync with relay/src/orderbook.ts) ---------------

export type OrderSide = 'ask' | 'bid';
export type OrderStatus = 'open' | 'matched' | 'cancelled' | 'expired';

export interface OrderPayload {
  id: string;
  side: OrderSide;
  posterNpub: string;
  posterSparkIdentityPubkey: string;
  assetId: string;
  amount: string;
  priceSats: number;
  paymentHash?: string;
  expiryTime: string;
  createdAt: string;
}

export interface SignedOrder extends OrderPayload {
  senderSignature: string;
}

export interface StoredOrder {
  order: SignedOrder;
  status: OrderStatus;
  matchedWith?: string;
  updatedAt: string;
}

export interface PlaceResult {
  status: 'open' | 'matched';
  id: string;
  matchedWith?: string;
  counterpartySparkPubkey?: string;
  counterpartyNpub?: string;
  paymentHash?: string;
  counterpartyOrder?: SignedOrder;
  /** Decimal-encoded amount actually transacted (Phase 1C/clean session 8.1).
   *  Equals `min(askAmount, bidAmount)` per the partial-fill model on the
   *  relay (bids never exceed asks). Absent on open orders. */
  matchedAmount?: string;
}

// ----- Error / base URL plumbing (same posture as consignmentRelay) ---------

export class OrderbookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'OrderbookError';
  }
}

const DEFAULT_BASE = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? 'http://localhost:5180'
  : '/relay';

function url(base: string | undefined, path: string): string {
  return `${base ?? DEFAULT_BASE}${path}`;
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      // keep statusText
    }
    throw new OrderbookError(res.status, `orderbook ${res.status}: ${msg}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('json')) {
    throw new OrderbookError(
      res.status,
      `orderbook returned non-JSON (content-type: ${ct || 'unset'}).`,
    );
  }
  return res.json();
}

// ----- Helpers --------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Tiny RFC 9562 UUID v7 generator. Browser-only (uses crypto.getRandomValues). */
export function uuidV7(): string {
  const ms = Date.now();
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const a = Math.floor(ms / 2 ** 16);
  const b = ms & 0xffff;
  const r = bytesToHex(rand);
  return [
    a.toString(16).padStart(8, '0'),
    b.toString(16).padStart(4, '0'),
    '7' + r.slice(0, 3),
    ((parseInt(r.slice(3, 5), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + r.slice(5, 7),
    r.slice(7, 19),
  ].join('-');
}

/**
 * Sign an OrderPayload with the poster's Nostr secret key. The relay
 * re-canonicalizes the payload (sans senderSignature), recomputes
 * sha256, and verifies the BIP-340 schnorr signature against the
 * x-only pubkey from `posterNpub` (via nip19 decode server-side).
 */
export function signOrder(payload: OrderPayload, nostrPrivkeyHex: string): SignedOrder {
  const canonical = canonicalize(payload as unknown as Record<string, unknown>);
  const digest = sha256(new TextEncoder().encode(canonical));
  const priv = hexToBytes(nostrPrivkeyHex);
  if (priv.length !== 32) throw new Error('nostrPrivkeyHex must be 32 bytes');
  const sig = schnorr.sign(digest, priv);
  return { ...payload, senderSignature: bytesToHex(sig) };
}

// ----- Public API -----------------------------------------------------------

/**
 * POST a signed order. On match, the response carries the counterparty
 * details required to drive the HTLC orchestrator (paymentHash for the
 * buyer side, counterparty Spark identity pubkey for both).
 */
export async function postOrder(
  signed: SignedOrder,
  opts?: { baseUrl?: string },
): Promise<PlaceResult> {
  const res = await fetch(url(opts?.baseUrl, `/order/${encodeURIComponent(signed.assetId)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  return await jsonOrThrow(res) as PlaceResult;
}

/** GET the open + matched orders for an asset. */
export async function listOrders(
  assetId: string,
  opts?: { baseUrl?: string },
): Promise<StoredOrder[]> {
  const res = await fetch(url(opts?.baseUrl, `/order/${encodeURIComponent(assetId)}`));
  return await jsonOrThrow(res) as StoredOrder[];
}

/**
 * DELETE a previously-placed order. The relay re-checks that the
 * requester's npub matches `order.posterNpub` via the Authorization
 * header. Matched orders are not cancellable (relay returns 409).
 */
export async function cancelOrder(
  assetId: string,
  orderId: string,
  requesterNpub: string,
  opts?: { baseUrl?: string },
): Promise<void> {
  const res = await fetch(
    url(opts?.baseUrl, `/order/${encodeURIComponent(assetId)}/${encodeURIComponent(orderId)}`),
    {
      method: 'DELETE',
      headers: { Authorization: `Npub ${requesterNpub}` },
    },
  );
  if (res.status === 204) return;
  // Same error decode as jsonOrThrow but tolerant of empty bodies.
  let msg = res.statusText;
  try {
    const body = await res.json() as { error?: string };
    if (body?.error) msg = body.error;
  } catch {
    // keep statusText
  }
  throw new OrderbookError(res.status, `orderbook ${res.status}: ${msg}`);
}
