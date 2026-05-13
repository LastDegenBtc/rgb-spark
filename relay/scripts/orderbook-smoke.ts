// Quick CLI smoke test for the orderbook routes.
//
// Generates two throwaway Nostr keypairs (Alice = seller, Bob = buyer),
// signs orders, POSTs them to a running relay, and verifies the matching
// + listing + cancellation flow. Run via:
//
//   cd relay && npx tsx scripts/orderbook-smoke.ts
//
// Assumes the relay is up on localhost:5180.

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { nip19 } from 'nostr-tools'
import { randomBytes } from 'node:crypto'

const RELAY = process.env.RELAY ?? 'http://localhost:5180'

function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'boolean') return JSON.stringify(value)
  if (t === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']'
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}'
  }
  throw new Error('unsupported type ' + t)
}

function uuidV7(): string {
  // Minimal UUID v7 generator for the test. Real clients use a proper lib.
  const ms = Date.now()
  const rand = randomBytes(10)
  const a = (ms / 2 ** 16) >>> 0
  const b = ms & 0xffff
  const hex = bytesToHex(rand)
  return [
    a.toString(16).padStart(8, '0'),
    b.toString(16).padStart(4, '0'),
    '7' + hex.slice(0, 3),
    ((parseInt(hex.slice(3, 5), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hex.slice(5, 7),
    hex.slice(7, 19),
  ].join('-')
}

function makeKeypair() {
  const priv = schnorr.utils.randomSecretKey()
  const xonly = schnorr.getPublicKey(priv)
  const npub = nip19.npubEncode(bytesToHex(xonly))
  // Spark identity pubkey is HD-derived in production. For the test we
  // fake it with a fresh 33-byte compressed pubkey unrelated to npub —
  // the relay doesn't check the relationship.
  const sparkPriv = randomBytes(32)
  const sparkXonly = schnorr.getPublicKey(sparkPriv)
  // Compressed form: 0x02 prefix + 32 bytes x-only.
  const sparkCompressed = '02' + bytesToHex(sparkXonly)
  return { priv, xonly, npub, sparkCompressed }
}

interface SignedOrder {
  id: string
  side: 'ask' | 'bid'
  posterNpub: string
  posterSparkIdentityPubkey: string
  assetId: string
  amount: string
  priceSats: number
  paymentHash?: string
  expiryTime: string
  createdAt: string
  senderSignature: string
}

function signOrder(payload: Omit<SignedOrder, 'senderSignature'>, priv: Uint8Array): SignedOrder {
  const canonical = canonicalize(payload)
  const msg = sha256(new TextEncoder().encode(canonical))
  const sig = schnorr.sign(msg, priv)
  return { ...payload, senderSignature: bytesToHex(sig) }
}

async function postOrder(assetId: string, order: SignedOrder) {
  const r = await fetch(`${RELAY}/order/${assetId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(order),
  })
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body }
}

async function listOrders(assetId: string) {
  const r = await fetch(`${RELAY}/order/${assetId}`)
  return { status: r.status, body: await r.json() }
}

async function cancelOrder(assetId: string, id: string, npub: string) {
  const r = await fetch(`${RELAY}/order/${assetId}/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Npub ${npub}` },
  })
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => ({})) }
}

async function expect(label: string, cond: boolean, ctx?: unknown) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    console.error(`  ✗ ${label}`)
    if (ctx !== undefined) console.error('    ctx:', ctx)
    process.exit(1)
  }
}

async function main() {
  console.log(`Smoke testing orderbook routes on ${RELAY}`)
  const alice = makeKeypair()
  const bob = makeKeypair()
  const assetId = bytesToHex(randomBytes(32))
  const paymentHash = bytesToHex(randomBytes(32))
  const expiry = new Date(Date.now() + 60 * 60_000).toISOString()
  const createdAt = new Date().toISOString()

  console.log('Phase 1: Alice posts an ask.')
  const askPayload = {
    id: uuidV7(),
    side: 'ask' as const,
    posterNpub: alice.npub,
    posterSparkIdentityPubkey: alice.sparkCompressed,
    assetId,
    amount: '1000',
    priceSats: 50_000,
    paymentHash,
    expiryTime: expiry,
    createdAt,
  }
  const ask = signOrder(askPayload, alice.priv)
  const askResp = await postOrder(assetId, ask)
  await expect('Alice ask accepted (201)', askResp.status === 201, askResp)
  await expect('ask returned status open', askResp.body.status === 'open', askResp.body)

  console.log('Phase 2: GET lists the ask.')
  const list1 = await listOrders(assetId)
  await expect('list returns 200', list1.status === 200)
  await expect('list contains the ask', list1.body.length === 1 && list1.body[0].order.id === ask.id)

  console.log('Phase 3: same-Alice re-POST is idempotent.')
  const askResp2 = await postOrder(assetId, ask)
  await expect('idempotent ack', askResp2.status === 201 && askResp2.body.id === ask.id)

  console.log('Phase 4: tampered signature rejected.')
  const tampered = { ...ask, senderSignature: '00'.repeat(64) }
  const badResp = await postOrder(assetId, tampered)
  await expect('bad sig rejected (400)', badResp.status === 400, badResp)

  console.log('Phase 5: Bob posts a matching bid (exact price + amount).')
  const bidPayload = {
    id: uuidV7(),
    side: 'bid' as const,
    posterNpub: bob.npub,
    posterSparkIdentityPubkey: bob.sparkCompressed,
    assetId,
    amount: '1000',
    priceSats: 50_000,
    expiryTime: expiry,
    createdAt: new Date().toISOString(),
  }
  const bid = signOrder(bidPayload, bob.priv)
  const bidResp = await postOrder(assetId, bid)
  await expect('Bob bid accepted', bidResp.status === 201, bidResp)
  await expect('bid status === matched', bidResp.body.status === 'matched')
  await expect('matchedWith == Alice ask id', bidResp.body.matchedWith === ask.id)
  await expect(
    'paymentHash propagated from ask',
    bidResp.body.paymentHash === paymentHash,
    bidResp.body,
  )
  await expect(
    'counterpartyNpub == Alice',
    bidResp.body.counterpartyNpub === alice.npub,
    bidResp.body,
  )

  console.log('Phase 6: a second matching bid is REJECTED (ask already matched).')
  const bid2Payload = { ...bidPayload, id: uuidV7(), createdAt: new Date().toISOString() }
  const bid2 = signOrder(bid2Payload, bob.priv)
  const bid2Resp = await postOrder(assetId, bid2)
  // It will create a new open bid (no opposing ask is still 'open'), not match.
  await expect('second bid stays open (no matching open ask)', bid2Resp.body.status === 'open', bid2Resp.body)

  console.log('Phase 7: cancel the second bid.')
  const cancelResp = await cancelOrder(assetId, bid2.id, bob.npub)
  await expect('cancel returns 204', cancelResp.status === 204, cancelResp)

  console.log('Phase 8: cannot cancel a matched order.')
  const tryCancelMatched = await cancelOrder(assetId, ask.id, alice.npub)
  await expect('cancel-matched returns 409', tryCancelMatched.status === 409, tryCancelMatched)

  console.log('Phase 9: cancel rejected with wrong npub.')
  const tryWrongNpub = await cancelOrder(assetId, bid.id, alice.npub)
  await expect('cancel wrong-npub returns 403', tryWrongNpub.status === 403, tryWrongNpub)

  console.log('Phase 10: same-poster self-match is refused.')
  // Alice posts a bid matching her own ask. Use a different asset id to avoid
  // the already-matched ask state. We need a NEW ask first.
  const assetId2 = bytesToHex(randomBytes(32))
  const askPayload2 = {
    ...askPayload,
    id: uuidV7(),
    assetId: assetId2,
    paymentHash: bytesToHex(randomBytes(32)),
    createdAt: new Date().toISOString(),
  }
  const ask2 = signOrder(askPayload2, alice.priv)
  await postOrder(assetId2, ask2)
  // Alice attempts to bid on her own ask.
  const selfBidPayload = {
    ...bidPayload,
    id: uuidV7(),
    posterNpub: alice.npub,
    posterSparkIdentityPubkey: alice.sparkCompressed,
    assetId: assetId2,
    createdAt: new Date().toISOString(),
  }
  const selfBid = signOrder(selfBidPayload, alice.priv)
  const selfMatchResp = await postOrder(assetId2, selfBid)
  await expect(
    'self-match refused (stays open)',
    selfMatchResp.body.status === 'open',
    selfMatchResp.body,
  )


  // ---- Partial-fill phase (Phase 1C/clean session 8.1) ----
  //
  // The relay now accepts bids whose amount is < ask amount, provided
  // the UNIT price matches exactly. The ask is consumed in full from
  // the orderbook side; the seller's wallet handles the change via the
  // split-merge pipeline (session 7.3).
  console.log('Phase 11: partial fill — bid 200 X / 10k sats against ask 1000 X / 50k sats.')
  const assetId3 = bytesToHex(randomBytes(32))
  const ask3 = signOrder(
    {
      id: uuidV7(),
      side: 'ask' as const,
      posterNpub: alice.npub,
      posterSparkIdentityPubkey: alice.sparkCompressed,
      assetId: assetId3,
      amount: '1000',
      priceSats: 50_000,
      paymentHash: bytesToHex(randomBytes(32)),
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    alice.priv,
  )
  await postOrder(assetId3, ask3)

  const partialBid = signOrder(
    {
      id: uuidV7(),
      side: 'bid' as const,
      posterNpub: bob.npub,
      posterSparkIdentityPubkey: bob.sparkCompressed,
      assetId: assetId3,
      amount: '200',
      // Same unit price: 50_000 / 1000 == 10_000 / 200 == 50 sats per X.
      priceSats: 10_000,
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    bob.priv,
  )
  const partialResp = await postOrder(assetId3, partialBid)
  await expect('partial bid matches', partialResp.body.status === 'matched', partialResp.body)
  await expect(
    'matchedAmount == bid amount (200)',
    partialResp.body.matchedAmount === '200',
    partialResp.body,
  )
  await expect(
    'matchedWith == ask3 id',
    partialResp.body.matchedWith === ask3.id,
    partialResp.body,
  )

  console.log('Phase 12: a subsequent bid against the SAME ask is refused (single-shot).')
  const ask4 = signOrder(
    {
      id: uuidV7(),
      side: 'ask' as const,
      posterNpub: alice.npub,
      posterSparkIdentityPubkey: alice.sparkCompressed,
      assetId: assetId3,
      amount: '500',
      priceSats: 25_000,
      paymentHash: bytesToHex(randomBytes(32)),
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    alice.priv,
  )
  // Try to bid 100 X against ask3 specifically — ask3 is already matched,
  // so this should fall through to ask4 (still open, same unit price).
  const partialBid2 = signOrder(
    {
      id: uuidV7(),
      side: 'bid' as const,
      posterNpub: bob.npub,
      posterSparkIdentityPubkey: bob.sparkCompressed,
      assetId: assetId3,
      amount: '100',
      priceSats: 5_000, // 50 sats per X — same unit price
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    bob.priv,
  )
  // Post ask4 first, then partial bid.
  await postOrder(assetId3, ask4)
  const partialBid2Resp = await postOrder(assetId3, partialBid2)
  await expect(
    'second partial bid matches the still-open ask4',
    partialBid2Resp.body.status === 'matched' && partialBid2Resp.body.matchedWith === ask4.id,
    partialBid2Resp.body,
  )

  console.log('Phase 13: unit-price MISMATCH is refused.')
  const ask5 = signOrder(
    {
      id: uuidV7(),
      side: 'ask' as const,
      posterNpub: alice.npub,
      posterSparkIdentityPubkey: alice.sparkCompressed,
      assetId: assetId3,
      amount: '1000',
      priceSats: 50_000,
      paymentHash: bytesToHex(randomBytes(32)),
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    alice.priv,
  )
  await postOrder(assetId3, ask5)

  // 200 X for 11_000 sats = 55 sats per X — different from ask5's 50.
  const mispricedBid = signOrder(
    {
      id: uuidV7(),
      side: 'bid' as const,
      posterNpub: bob.npub,
      posterSparkIdentityPubkey: bob.sparkCompressed,
      assetId: assetId3,
      amount: '200',
      priceSats: 11_000,
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    bob.priv,
  )
  const mispricedResp = await postOrder(assetId3, mispricedBid)
  await expect(
    'mismatched unit price stays open (no match)',
    mispricedResp.body.status === 'open',
    mispricedResp.body,
  )

  console.log('Phase 14: bid amount > ask amount is refused.')
  // Ask5 still open (mispriced bid above did not consume it).
  const overbid = signOrder(
    {
      id: uuidV7(),
      side: 'bid' as const,
      posterNpub: bob.npub,
      posterSparkIdentityPubkey: bob.sparkCompressed,
      assetId: assetId3,
      amount: '1500', // > ask5.amount = 1000
      // Same unit price: 50_000/1000 == 75_000/1500 == 50.
      priceSats: 75_000,
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    bob.priv,
  )
  const overbidResp = await postOrder(assetId3, overbid)
  await expect(
    'overbid (bid amount > ask amount) stays open',
    overbidResp.body.status === 'open',
    overbidResp.body,
  )


  // ---- Registry phases (Phase 1C/clean session 9) ----
  console.log('Phase 15: registry surfaces the asset we just touched.')
  const statsResp = await fetch(`${RELAY}/asset/${assetId3}/stats`)
  const stats: {
    contractId: string
    firstSeenAt: string
    lastActivityAt: string
    openOrdersCount: number
    matchedOrdersCount: number
    cancelledOrdersCount: number
    expiredOrdersCount: number
  } = await statsResp.json()
  await expect('asset stats 200', statsResp.status === 200, stats)
  await expect(
    'matched > 0 (saw the partial-fill matches)',
    stats.matchedOrdersCount > 0,
    stats,
  )
  await expect(
    'open count includes the still-open ask5 + mispriced bid + overbid',
    stats.openOrdersCount >= 3,
    stats,
  )

  console.log('Phase 16: /registry/assets lists assetId3 in active markets.')
  const listResp = await fetch(`${RELAY}/registry/assets?limit=50`)
  const assets: Array<{ contractId: string }> = await listResp.json()
  await expect('registry list 200', listResp.status === 200, assets)
  await expect(
    'registry contains assetId3',
    assets.some((a) => a.contractId === assetId3.toLowerCase()),
    assets.map((a) => a.contractId),
  )

  console.log('Phase 17: unknown asset stats returns 404.')
  const unknownResp = await fetch(`${RELAY}/asset/${'aa'.repeat(32)}/stats`)
  await expect('unknown asset 404', unknownResp.status === 404)

  // ---- SSE phases (Phase 1C/clean session 10) ----
  // Node's global fetch supports streaming responses, so we use it
  // directly rather than pulling in a polyfill for EventSource.
  console.log('Phase 18: SSE stream emits order_placed when a new order is posted.')
  const sseAbort = new AbortController()
  const sseResp = await fetch(`${RELAY}/events`, { signal: sseAbort.signal })
  await expect('SSE connect 200', sseResp.status === 200, sseResp.status)
  await expect(
    'SSE content-type text/event-stream',
    (sseResp.headers.get('content-type') ?? '').includes('text/event-stream'),
    sseResp.headers.get('content-type'),
  )

  // Tee a reader and collect events as text chunks until we either see
  // our target event or timeout.
  const sseEvents: string[] = []
  const reader = sseResp.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const collectUntil = (predicate: (e: string) => boolean, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            clearTimeout(timer)
            resolve(false)
            return
          }
          buffered += decoder.decode(value, { stream: true })
          // SSE messages are delimited by blank lines.
          let idx: number
          while ((idx = buffered.indexOf('\n\n')) >= 0) {
            const block = buffered.slice(0, idx)
            buffered = buffered.slice(idx + 2)
            sseEvents.push(block)
            if (predicate(block)) {
              clearTimeout(timer)
              resolve(true)
              return
            }
          }
        }
      }
      pump().catch(() => resolve(false))
    })

  // Post a new ask on a fresh asset and wait for the corresponding
  // order_placed event.
  const assetId4 = bytesToHex(randomBytes(32))
  const sseAsk = signOrder(
    {
      id: uuidV7(),
      side: 'ask' as const,
      posterNpub: alice.npub,
      posterSparkIdentityPubkey: alice.sparkCompressed,
      assetId: assetId4,
      amount: '500',
      priceSats: 25_000,
      paymentHash: bytesToHex(randomBytes(32)),
      expiryTime: expiry,
      createdAt: new Date().toISOString(),
    },
    alice.priv,
  )
  // Fire the POST AFTER attaching the listener, but don't await before
  // we start collecting — race-free because the relay processes the
  // POST synchronously and the SSE write goes into the same event loop.
  const postPromise = postOrder(assetId4, sseAsk)
  const sawPlaced = await collectUntil(
    (block) => block.includes('"order_placed"') && block.includes(assetId4.toLowerCase()),
    5_000,
  )
  await postPromise
  await expect('SSE order_placed received within 5s', sawPlaced, sseEvents.slice(-3))

  // Close the SSE connection so the smoke test process can exit cleanly.
  sseAbort.abort()

  console.log('\nAll orderbook smoke tests passed.')
}

main().catch((e) => {
  console.error('smoke test failed:', e)
  process.exit(1)
})
