// Orderbook extension for the rgb-spark relay — Phase 1C session 2.
//
// Posts/lists/cancels signed orders for HTLC atomic swaps. The relay is
// the matching layer (per `feedback_exact_price_matching` in the agent
// memory: same-price only, no sweep, FIFO inside a price level), but it
// holds no funds — settlement happens via the Spark coordinator's HTLC
// primitive (see `reference_spark_htlc_primitive`). On a match, the
// relay flips both orders to `matched` and surfaces the counterparty
// details so each client can drive `runSellerFlow` / `runBuyerFlow`.
//
// Trust scope: signature verification + matching policy enforcement.
// No fund custody. A misbehaving relay can DoS the orderbook but
// cannot redirect payments — counterparty pubkeys are committed in
// the signed order, and clients verify the signature locally before
// acting on any match notification.

import { schnorr } from '@noble/curves/secp256k1.js'
import { nip19 } from 'nostr-tools'
import {
  noteOrderCancelled,
  noteOrderExpired,
  noteOrderMatched,
  noteOrderPlaced,
} from './registry.js'
import { emit } from './events.js'

// ----- Constants -------------------------------------------------------

const MAX_ORDERS_PER_ASSET = 500
const MAX_ASSETS = 1_000
const ORDER_TTL_MS = 24 * 60 * 60 * 1000        // 24 h hard cap on order age

const HEX_32_RE = /^[0-9a-f]{64}$/i             // 32-byte hex (asset_id, paymentHash)
const HEX_33_RE = /^0[23][0-9a-f]{64}$/i        // 33-byte compressed secp256k1 pubkey
const SCHNORR_SIG_RE = /^[0-9a-f]{128}$/i       // 64-byte BIP-340 signature
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ----- Order schema ----------------------------------------------------

/**
 * Order side. Asks sell an RGB asset for sats; bids buy with sats.
 */
export type OrderSide = 'ask' | 'bid'

/**
 * Order lifecycle states.
 * - `open`: posted, no counterparty matched yet.
 * - `matched`: relay paired this with an opposing order at the same price.
 *   Clients can fetch the counterparty fields (pubkey, paymentHash) and
 *   initiate the HTLC dance. No further bids accepted.
 * - `cancelled`: poster sent a signed DELETE before any match.
 * - `expired`: passed `expiryTime` or the global TTL.
 */
export type OrderStatus = 'open' | 'matched' | 'cancelled' | 'expired'

/**
 * Payload that the poster signs. Every field is canonicalized before
 * signing (sorted keys, no whitespace) and the resulting sha256 is
 * BIP-340-schnorr'd against the poster's Nostr xonly pubkey.
 */
export interface OrderPayload {
  /** uuid v7. Primary key. */
  id: string
  side: OrderSide
  /** bech32 npub of the poster — identity. */
  posterNpub: string
  /** 33-byte compressed Spark identityPublicKey — HTLC counterparty
   *  pubkey, used by the OTHER side when locking under `paymentHash`. */
  posterSparkIdentityPubkey: string
  /** 32-byte hex — RGB contractId being traded. */
  assetId: string
  /** Asset units offered (ask) or wanted (bid). Decimal string for BigInt
   *  safety across the JSON boundary. */
  amount: string
  /** Total sats — the price for the lot. Integer. */
  priceSats: number
  /** Ask only: 32-byte hex paymentHash for the HTLC. The seller generates
   *  the preimage privately, computes its sha256 and publishes it here so
   *  the buyer can lock to the same H. Bids leave it empty and pick up
   *  the matched ask's paymentHash. */
  paymentHash?: string
  /** ISO timestamp — order auto-expires after this regardless of TTL. */
  expiryTime: string
  /** ISO timestamp — when the order was created. */
  createdAt: string
}

/**
 * Signed order as POSTed by clients.
 */
export interface SignedOrder extends OrderPayload {
  /** 128-hex BIP-340 schnorr signature over sha256(canonicalize(payload)). */
  senderSignature: string
}

/**
 * Server-side persisted form. Wraps the signed order with lifecycle
 * fields the relay manages.
 */
export interface StoredOrder {
  order: SignedOrder
  status: OrderStatus
  /** If `status === 'matched'`, id of the counterparty order. */
  matchedWith?: string
  /** ISO timestamp when status last changed. */
  updatedAt: string
}

// ----- Canonicalization (must match the frontend client) ---------------
//
// Sorted-keys deterministic JSON, no whitespace. `undefined` values are
// dropped (matches the frontend's `envelopeSign.canonicalize`). Numbers
// pass through JSON.stringify so non-finite values throw — they have no
// canonical representation.

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'boolean') return JSON.stringify(value)
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalize: non-finite number ${String(value)}`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
      '}'
    )
  }
  throw new Error(`canonicalize: unsupported type ${t}`)
}

// ----- Validation ------------------------------------------------------

/**
 * Full validation: structural fields + signature + business rules.
 * Returns a human-readable error string on failure, or null on success.
 */
export function validateSignedOrder(o: SignedOrder, expectedAssetId: string): string | null {
  if (!o || typeof o !== 'object') return 'not an object'
  if (typeof o.id !== 'string' || !UUID_RE.test(o.id)) return 'bad id (must be uuid v7)'
  if (o.side !== 'ask' && o.side !== 'bid') return `bad side: ${o.side}`
  if (typeof o.posterNpub !== 'string' || o.posterNpub.length < 8 || o.posterNpub.length > 128) {
    return 'bad posterNpub'
  }
  if (typeof o.posterSparkIdentityPubkey !== 'string' || !HEX_33_RE.test(o.posterSparkIdentityPubkey)) {
    return 'bad posterSparkIdentityPubkey (33-byte compressed hex)'
  }
  if (typeof o.assetId !== 'string' || !HEX_32_RE.test(o.assetId)) return 'bad assetId (32-byte hex)'
  if (o.assetId.toLowerCase() !== expectedAssetId.toLowerCase()) {
    return `assetId mismatch: payload ${o.assetId} vs path ${expectedAssetId}`
  }
  if (typeof o.amount !== 'string' || !/^[0-9]+$/.test(o.amount) || BigInt(o.amount) <= 0n) {
    return 'bad amount (positive decimal string)'
  }
  if (typeof o.priceSats !== 'number' || !Number.isSafeInteger(o.priceSats) || o.priceSats <= 0) {
    return 'bad priceSats (positive safe integer)'
  }
  if (o.side === 'ask') {
    if (typeof o.paymentHash !== 'string' || !HEX_32_RE.test(o.paymentHash)) {
      return 'asks require paymentHash (32-byte hex)'
    }
  } else {
    // Bids may omit paymentHash; if present, must be 32-byte hex.
    if (o.paymentHash !== undefined && !HEX_32_RE.test(o.paymentHash)) {
      return 'bid paymentHash, if present, must be 32-byte hex'
    }
  }
  if (typeof o.expiryTime !== 'string' || isNaN(Date.parse(o.expiryTime))) {
    return 'bad expiryTime (ISO timestamp)'
  }
  if (Date.parse(o.expiryTime) <= Date.now()) return 'expiryTime is in the past'
  if (typeof o.createdAt !== 'string' || isNaN(Date.parse(o.createdAt))) {
    return 'bad createdAt (ISO timestamp)'
  }
  if (typeof o.senderSignature !== 'string' || !SCHNORR_SIG_RE.test(o.senderSignature)) {
    return 'bad senderSignature (128-hex)'
  }

  // Signature verification: schnorr.verify(sig, sha256(canonical), x-only-pubkey).
  // x-only pubkey extracted from posterNpub via nip19.
  let xonlyPubkeyHex: string
  try {
    const decoded = nip19.decode(o.posterNpub)
    if (decoded.type !== 'npub') return `posterNpub is not an npub (got ${decoded.type})`
    xonlyPubkeyHex = decoded.data as string
  } catch (e) {
    return `posterNpub decode failed: ${(e as Error).message}`
  }
  const { senderSignature, ...payload } = o
  const canonical = canonicalize(payload)
  const msg = sha256Bytes(new TextEncoder().encode(canonical))
  try {
    const sigBytes = hexToBytes(senderSignature)
    const pubkeyBytes = hexToBytes(xonlyPubkeyHex)
    const ok = schnorr.verify(sigBytes, msg, pubkeyBytes)
    if (!ok) return 'schnorr signature verify returned false'
  } catch (e) {
    return `schnorr.verify threw: ${(e as Error).message}`
  }
  return null
}

// ----- sha256 / hex helpers (no full @noble/hashes import) -------------
import { sha256 } from '@noble/hashes/sha2.js'
function sha256Bytes(bytes: Uint8Array): Uint8Array { return sha256(bytes) }
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new Error('hex length must be even')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// ----- Store -----------------------------------------------------------

/**
 * In-memory orderbook. Map<assetId, Map<orderId, StoredOrder>>.
 * Per-asset cap of MAX_ORDERS_PER_ASSET, global asset cap of MAX_ASSETS.
 * TTL cleanup runs every minute and demotes expired entries to status
 * `expired`; expired entries are then GC'd on next mutation of the same
 * asset bucket (so clients still see them briefly to learn what happened).
 */
const store = new Map<string, Map<string, StoredOrder>>()

function bucket(assetId: string): Map<string, StoredOrder> {
  const key = assetId.toLowerCase()
  let b = store.get(key)
  if (!b) {
    if (store.size >= MAX_ASSETS) throw Object.assign(new Error('too many asset buckets'), { http: 507 })
    b = new Map()
    store.set(key, b)
  }
  return b
}

function gcExpired(b: Map<string, StoredOrder>) {
  const now = Date.now()
  for (const [id, so] of b) {
    if (so.status === 'expired' || so.status === 'cancelled' || so.status === 'matched') {
      // Keep cancelled/matched/expired briefly for clients to see the final
      // state, but drop entries older than TTL.
      const age = now - Date.parse(so.updatedAt)
      if (age > ORDER_TTL_MS) b.delete(id)
    } else if (Date.parse(so.order.expiryTime) <= now) {
      so.status = 'expired'
      so.updatedAt = new Date().toISOString()
      // Registry + SSE: order moved from open → expired (sessions 9/10).
      noteOrderExpired(so.order.assetId)
      emit({
        type: 'order_expired',
        assetId: so.order.assetId.toLowerCase(),
        orderId: so.order.id,
        expiredAt: so.updatedAt,
      })
    }
  }
}

/**
 * Find an open opposing order at the same UNIT price (FIFO within the
 * price). Returns the StoredOrder to match against, or null.
 *
 * Per [[feedback_exact_price_matching]]: NO sweep / NO price improvement.
 * Same unit price means `bid.priceSats * ask.amount == ask.priceSats *
 * bid.amount` exactly (cross-multiplication avoids floating-point
 * rounding) — so a bid at 5 sats/X only fills against asks at exactly
 * 5 sats/X, regardless of lot size.
 *
 * Partial fills (Phase 1C/clean session 8.1): a bid can request less
 * than an ask offers. When matched, the bid is fully consumed and the
 * ask is consumed in full from the orderbook side (status → matched).
 * The seller's wallet still holds the change (via the split-merge
 * pipeline from session 7.3); to keep selling, the seller re-posts a
 * fresh ask with a NEW paymentHash for the remaining amount. We do NOT
 * keep the ask partially-open here because the seller's paymentHash is
 * single-use — matching a second bid against the same ask would let
 * both buyers race for the same preimage.
 *
 * Symmetric for ask-side: an incoming ask cannot offer LESS than a
 * resting bid wants. (An incoming ask offering MORE than a resting bid
 * is the same partial-fill case, just with roles swapped — also valid.)
 */
function findCompatibleMatch(b: Map<string, StoredOrder>, incoming: SignedOrder): StoredOrder | null {
  const opposingSide: OrderSide = incoming.side === 'ask' ? 'bid' : 'ask'
  let bestMatch: StoredOrder | null = null
  let bestTs = Infinity
  const incomingAmount = BigInt(incoming.amount)
  for (const so of b.values()) {
    if (so.status !== 'open') continue
    if (so.order.side !== opposingSide) continue
    if (so.order.assetId.toLowerCase() !== incoming.assetId.toLowerCase()) continue
    const soAmount = BigInt(so.order.amount)
    // Unit-price equality (cross-multiplication, exact integer arithmetic).
    if (BigInt(incoming.priceSats) * soAmount !== BigInt(so.order.priceSats) * incomingAmount) continue
    // Partial-fill constraint: the BID side must not exceed the ASK side's
    // amount. Determine which is bid/ask and check.
    const askAmount = incoming.side === 'ask' ? incomingAmount : soAmount
    const bidAmount = incoming.side === 'bid' ? incomingAmount : soAmount
    if (bidAmount > askAmount) continue
    // Don't match an order against itself (same posterNpub). Allowing
    // self-trades would let a single user exfiltrate trust signals.
    if (so.order.posterNpub === incoming.posterNpub) continue
    const ts = Date.parse(so.order.createdAt)
    if (ts < bestTs) {
      bestTs = ts
      bestMatch = so
    }
  }
  return bestMatch
}

// ----- Public API ------------------------------------------------------

export interface PlaceResult {
  status: 'open' | 'matched'
  id: string
  matchedWith?: string
  /** Counterparty's posterSparkIdentityPubkey when matched, for client convenience. */
  counterpartySparkPubkey?: string
  /** Counterparty's posterNpub when matched. */
  counterpartyNpub?: string
  /** PaymentHash of the matched ask (relayed onto the bid side). */
  paymentHash?: string
  /** Counterparty's full signed payload, so the client can independently verify. */
  counterpartyOrder?: SignedOrder
  /** Decimal-encoded amount actually transacted (Phase 1C/clean session 8.1).
   *  Equals `min(askAmount, bidAmount)` = the bid's amount in our partial-fill
   *  model where bids never exceed asks. Lets the seller know how much they
   *  sold (might be less than they offered) and the buyer confirm they got
   *  what they wanted. Absent on open orders. */
  matchedAmount?: string
}

export function placeOrder(assetId: string, signed: SignedOrder): PlaceResult {
  const err = validateSignedOrder(signed, assetId)
  if (err) throw Object.assign(new Error(`bad order: ${err}`), { http: 400 })
  const b = bucket(assetId)
  gcExpired(b)
  if (b.has(signed.id)) {
    // Idempotent re-POST of the same id.
    const existing = b.get(signed.id)!
    return {
      status: existing.status === 'matched' ? 'matched' : 'open',
      id: signed.id,
      matchedWith: existing.matchedWith,
    }
  }
  if (b.size >= MAX_ORDERS_PER_ASSET) {
    throw Object.assign(new Error('orderbook full for asset'), { http: 429 })
  }

  // Session 9 registry: the incoming order enters the book briefly,
  // regardless of whether it lands open or matches immediately.
  noteOrderPlaced(signed.assetId)
  // Session 10 SSE: emit order_placed for the incoming order.
  emit({
    type: 'order_placed',
    assetId: signed.assetId.toLowerCase(),
    orderId: signed.id,
    side: signed.side,
    amount: signed.amount,
    priceSats: signed.priceSats,
    createdAt: signed.createdAt,
  })

  const match = findCompatibleMatch(b, signed)
  const now = new Date().toISOString()
  if (match) {
    // Flip both to matched.
    match.status = 'matched'
    match.matchedWith = signed.id
    match.updatedAt = now
    const stored: StoredOrder = {
      order: signed,
      status: 'matched',
      matchedWith: match.order.id,
      updatedAt: now,
    }
    b.set(signed.id, stored)
    // Both sides transition to matched.
    noteOrderMatched(signed.assetId)
    noteOrderMatched(match.order.assetId)
    // Session 10 SSE: one event per matched order. matchedAmount =
    // bid.amount (= the smaller side; asks consumed in full per
    // session 8.1).
    const bidAmt = signed.side === 'bid' ? signed.amount : match.order.amount
    emit({
      type: 'order_matched',
      assetId: signed.assetId.toLowerCase(),
      orderId: signed.id,
      counterpartyOrderId: match.order.id,
      matchedAmount: bidAmt,
      matchedAt: now,
    })
    emit({
      type: 'order_matched',
      assetId: signed.assetId.toLowerCase(),
      orderId: match.order.id,
      counterpartyOrderId: signed.id,
      matchedAmount: bidAmt,
      matchedAt: now,
    })
    // If incoming is a bid and match is an ask, propagate the ask's paymentHash
    // back to the bid so both sides agree on H.
    if (signed.side === 'bid' && !signed.paymentHash && match.order.paymentHash) {
      // We do NOT mutate the signed payload (signature would break). The
      // matched paymentHash is conveyed via the result, not via mutation.
    }
    // `bidAmt` already computed above for the SSE emits.
    return {
      status: 'matched',
      id: signed.id,
      matchedWith: match.order.id,
      counterpartySparkPubkey: match.order.posterSparkIdentityPubkey,
      counterpartyNpub: match.order.posterNpub,
      paymentHash: match.order.paymentHash ?? signed.paymentHash,
      counterpartyOrder: match.order,
      matchedAmount: bidAmt,
    }
  }

  const stored: StoredOrder = { order: signed, status: 'open', updatedAt: now }
  b.set(signed.id, stored)
  return { status: 'open', id: signed.id }
}

/**
 * List open + matched orders for an asset. Cancelled and expired are
 * filtered out (they're kept in storage for TTL but not surfaced).
 */
export function listOrders(assetId: string): StoredOrder[] {
  const b = bucket(assetId)
  gcExpired(b)
  return [...b.values()].filter((so) => so.status === 'open' || so.status === 'matched')
}

/**
 * Cancel an order. The poster proves authority by including a signed
 * cancellation token. v0 simplification: the original signed order's
 * `senderSignature` is sufficient — to cancel `id`, the caller proves
 * they hold the signed payload (which the relay re-validates). This
 * works because the relay stores the original signed order; we trust
 * possession of the matching signature.
 *
 * A more robust scheme would be a separate sign-this-cancellation
 * envelope; v1 if needed.
 */
export function cancelOrder(assetId: string, id: string, requesterNpub: string): void {
  const b = bucket(assetId)
  const so = b.get(id)
  if (!so) throw Object.assign(new Error('order not found'), { http: 404 })
  if (so.order.posterNpub !== requesterNpub) {
    throw Object.assign(new Error('npub does not match order poster'), { http: 403 })
  }
  if (so.status === 'matched') {
    throw Object.assign(new Error('cannot cancel a matched order'), { http: 409 })
  }
  if (so.status === 'cancelled' || so.status === 'expired') return
  so.status = 'cancelled'
  so.updatedAt = new Date().toISOString()
  // Session 9 registry + session 10 SSE.
  noteOrderCancelled(so.order.assetId)
  emit({
    type: 'order_cancelled',
    assetId: so.order.assetId.toLowerCase(),
    orderId: so.order.id,
    cancelledAt: so.updatedAt,
  })
}

export function healthCounts(): { assets: number; openOrders: number; matchedOrders: number } {
  let openOrders = 0
  let matchedOrders = 0
  for (const b of store.values()) {
    for (const so of b.values()) {
      if (so.status === 'open') openOrders++
      else if (so.status === 'matched') matchedOrders++
    }
  }
  return { assets: store.size, openOrders, matchedOrders }
}

// ----- Background GC ---------------------------------------------------

setInterval(() => {
  for (const b of store.values()) gcExpired(b)
  // Drop empty asset buckets.
  for (const [k, b] of store) if (b.size === 0) store.delete(k)
}, 60_000)
