// rgb-spark consignment relay — v0
//
// Stateless mailbox. The server holds opaque per-recipient byte blobs and
// forgets them once the recipient acks. It learns nothing about senders
// (no auth on POST), and its only knowledge about recipients is the npub
// string used as the queue key. Privacy of contents is the *client's* job
// (sender encrypts to recipient's npub before POSTing — out of scope here).
//
// Per-npub queue cap and per-blob size cap are the only safety knobs; both
// are tuneable via env. No persistence: a restart wipes pending mail. That
// is the v0 contract — recipients must poll often, senders must accept
// re-POST on relay restart.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  placeOrder,
  listOrders,
  cancelOrder,
  healthCounts as orderbookHealth,
  type SignedOrder,
} from './orderbook.js'
import {
  listAssets,
  getAssetStats,
  registryHealth,
  type RegistrySortKey,
} from './registry.js'
import { subscribe as subscribeEvents, subscriberCount } from './events.js'

const PORT = Number(process.env.PORT ?? 5180)
const HOST = process.env.HOST ?? '0.0.0.0'
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 1_048_576)        // 1 MiB / blob
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 100)              // blobs / npub
const MAX_NPUBS = Number(process.env.MAX_NPUBS ?? 10_000)           // total npubs

// Accept Nostr bech32 (`npub1…`), hex pubkey, or any URL-safe identifier
// in that shape. We do not bind the identifier to any cryptographic check
// here — clients exchange npubs out of band and we just route bytes.
const NPUB_RE = /^[A-Za-z0-9_-]{8,128}$/
const ID_RE   = /^[0-9a-f-]{36}$/

interface Entry {
  id: string
  bytes: Buffer
  receivedAt: string
}

const store = new Map<string, Entry[]>()

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let oversized = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > cap) {
        oversized = true
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (oversized) reject(Object.assign(new Error('payload too large'), { http: 413 }))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body?: Buffer | string | object, type?: string) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  if (body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  let out: Buffer | string
  if (Buffer.isBuffer(body)) {
    out = body
    headers['Content-Type'] = type ?? 'application/octet-stream'
  } else if (typeof body === 'string') {
    out = body
    headers['Content-Type'] = type ?? 'text/plain; charset=utf-8'
  } else {
    out = JSON.stringify(body)
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  headers['Content-Length'] = String(Buffer.byteLength(out))
  res.writeHead(status, headers)
  res.end(out)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? 'GET'
  const url = req.url ?? '/'

  if (method === 'OPTIONS') return send(res, 204)

  if (url === '/healthz') {
    return send(res, 200, {
      ok: true,
      npubs: store.size,
      pending: [...store.values()].reduce((n, q) => n + q.length, 0),
      orderbook: orderbookHealth(),
      registry: registryHealth(),
      events: { subscribers: subscriberCount() },
    })
  }

  // /events — SSE stream (Phase 1C/clean session 10).
  if (method === 'GET' && url === '/events') {
    const unsubscribe = subscribeEvents(res)
    // The SSE response stays open until the client disconnects. Hook
    // request close to clean up; do NOT send a response from here.
    req.on('close', () => {
      unsubscribe()
    })
    return // intentional: SSE keeps the connection open
  }

  // /registry/assets?limit=&offset=&sortBy=
  if (method === 'GET' && url.startsWith('/registry/assets')) {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    const params = new URLSearchParams(qs)
    const limit = params.get('limit') ? Number(params.get('limit')) : undefined
    const offset = params.get('offset') ? Number(params.get('offset')) : undefined
    const sortByRaw = params.get('sortBy')
    let sortBy: RegistrySortKey | undefined
    if (sortByRaw === 'lastActivityAt' || sortByRaw === 'firstSeenAt' || sortByRaw === 'matchedOrdersCount') {
      sortBy = sortByRaw
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      return send(res, 400, { error: 'limit must be a non-negative integer' })
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      return send(res, 400, { error: 'offset must be a non-negative integer' })
    }
    const list = listAssets({ limit, offset, sortBy })
    return send(res, 200, list)
  }

  // /asset/:contractId/stats
  const statsMatch = url.match(/^\/asset\/([0-9a-fA-F]{64})\/stats\/?$/)
  if (statsMatch && method === 'GET') {
    const contractId = statsMatch[1]!
    const entry = getAssetStats(contractId)
    if (!entry) return send(res, 404, { error: 'asset not in registry' })
    return send(res, 200, entry)
  }

  // /order/:assetId or /order/:assetId/:orderId
  const orderMatch = url.match(/^\/order\/([0-9a-fA-F]{64})(?:\/([0-9a-f-]{36}))?\/?$/)
  if (orderMatch) {
    const assetId = orderMatch[1]!
    const orderId = orderMatch[2]

    if (method === 'POST' && !orderId) {
      let body: Buffer
      try {
        body = await readBody(req, MAX_BYTES)
      } catch (e) {
        const status = (e as { http?: number }).http ?? 400
        return send(res, status, { error: status === 413 ? 'payload too large' : 'read error' })
      }
      if (body.length === 0) return send(res, 400, { error: 'empty body' })
      let signed: SignedOrder
      try {
        signed = JSON.parse(body.toString('utf8')) as SignedOrder
      } catch {
        return send(res, 400, { error: 'body is not JSON' })
      }
      try {
        const result = placeOrder(assetId, signed)
        return send(res, 201, result)
      } catch (e) {
        const status = (e as { http?: number }).http ?? 400
        return send(res, status, { error: (e as Error).message })
      }
    }

    if (method === 'GET' && !orderId) {
      const list = listOrders(assetId)
      return send(res, 200, list)
    }

    if (method === 'DELETE' && orderId) {
      // Caller passes their npub via Authorization header (`Authorization: Npub <npub>`).
      // The relay checks the npub matches the order's posterNpub; this is a v0
      // simplification — possession of the original signed order is the actual
      // authority, but the relay already stores it server-side. Future hardening:
      // sign a fresh cancellation envelope.
      const auth = req.headers['authorization'] ?? ''
      const m = /^Npub\s+(\S+)$/i.exec(typeof auth === 'string' ? auth : auth[0] ?? '')
      if (!m) return send(res, 401, { error: 'Authorization: Npub <npub> header required' })
      try {
        cancelOrder(assetId, orderId, m[1]!)
        return send(res, 204)
      } catch (e) {
        const status = (e as { http?: number }).http ?? 400
        return send(res, status, { error: (e as Error).message })
      }
    }

    return send(res, 405, { error: 'method not allowed on /order' })
  }

  // /consignment/:npub  or  /consignment/:npub/:id
  const m = url.match(/^\/consignment\/([^/?#]+)(?:\/([^/?#]+))?\/?$/)
  if (!m) return send(res, 404, { error: 'not found' })
  const npub = decodeURIComponent(m[1]!)
  const id = m[2] ? decodeURIComponent(m[2]) : undefined
  if (!NPUB_RE.test(npub)) return send(res, 400, { error: 'bad npub' })
  if (id !== undefined && !ID_RE.test(id)) return send(res, 400, { error: 'bad id' })

  if (method === 'POST' && id === undefined) {
    if (!store.has(npub) && store.size >= MAX_NPUBS) {
      return send(res, 507, { error: 'relay full' })
    }
    let body: Buffer
    try {
      body = await readBody(req, MAX_BYTES)
    } catch (e) {
      const status = (e as { http?: number }).http ?? 400
      return send(res, status, { error: status === 413 ? 'payload too large' : 'read error' })
    }
    if (body.length === 0) return send(res, 400, { error: 'empty body' })
    const queue = store.get(npub) ?? []
    if (queue.length >= MAX_QUEUE) return send(res, 429, { error: 'queue full' })
    const entry: Entry = { id: randomUUID(), bytes: body, receivedAt: new Date().toISOString() }
    queue.push(entry)
    store.set(npub, queue)
    return send(res, 201, { id: entry.id, size: body.length, receivedAt: entry.receivedAt })
  }

  if (method === 'GET' && id === undefined) {
    const queue = store.get(npub) ?? []
    return send(res, 200, queue.map((e) => ({ id: e.id, size: e.bytes.length, receivedAt: e.receivedAt })))
  }

  if (method === 'GET' && id !== undefined) {
    const queue = store.get(npub) ?? []
    const entry = queue.find((e) => e.id === id)
    if (!entry) return send(res, 404, { error: 'not found' })
    return send(res, 200, entry.bytes, 'application/octet-stream')
  }

  if (method === 'DELETE' && id !== undefined) {
    const queue = store.get(npub) ?? []
    const idx = queue.findIndex((e) => e.id === id)
    if (idx < 0) return send(res, 404, { error: 'not found' })
    queue.splice(idx, 1)
    if (queue.length === 0) store.delete(npub)
    else store.set(npub, queue)
    return send(res, 204)
  }

  return send(res, 405, { error: 'method not allowed' })
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('unhandled', e)
    if (!res.headersSent) send(res, 500, { error: 'internal' })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`rgb-spark relay listening on http://${HOST}:${PORT}`)
  console.log(`  MAX_BYTES=${MAX_BYTES}  MAX_QUEUE=${MAX_QUEUE}  MAX_NPUBS=${MAX_NPUBS}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`${sig} — closing`)
    server.close(() => process.exit(0))
  })
}
