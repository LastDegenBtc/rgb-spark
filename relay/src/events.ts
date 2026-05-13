// Event bus for the rgb-spark relay (Phase 1C/clean session 10).
//
// Broadcasts lifecycle events to any number of subscribers via Server-
// Sent Events. RGB-SPK's UX (live trade ticker, order-book depth,
// activity heatmap — RGB-SPK.md §4) wants sub-second update cadence
// without polling — this is how it gets there.
//
// In-memory and stateless. A subscriber that misses events while
// disconnected can fall back to REST (`GET /registry/assets`, etc.)
// to reconcile. We don't persist or replay.

import type { ServerResponse } from 'node:http'

export type RelayEvent =
  | { type: 'order_placed'; assetId: string; orderId: string; side: 'ask' | 'bid'; amount: string; priceSats: number; createdAt: string }
  | { type: 'order_matched'; assetId: string; orderId: string; counterpartyOrderId: string; matchedAmount: string; matchedAt: string }
  | { type: 'order_cancelled'; assetId: string; orderId: string; cancelledAt: string }
  | { type: 'order_expired'; assetId: string; orderId: string; expiredAt: string }
  | { type: 'asset_registered'; assetId: string; firstSeenAt: string }
  | { type: 'heartbeat'; sentAt: string }

interface Subscriber {
  res: ServerResponse
  /** Monotonic id assigned at subscription time, used to identify the
   *  subscriber for cleanup. */
  id: number
}

const subscribers = new Set<Subscriber>()
let nextSubscriberId = 1
const HEARTBEAT_INTERVAL_MS = 25_000

/**
 * Attach a new SSE client. Writes SSE headers, replies an initial
 * comment-style "connected" line, and returns an unsubscribe handle.
 * The caller is responsible for invoking the handle when the client
 * disconnects (req.on('close')).
 */
export function subscribe(res: ServerResponse): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // disable nginx buffering for /events
  })
  res.write(': connected\n\n')

  const sub: Subscriber = { res, id: nextSubscriberId++ }
  subscribers.add(sub)
  return () => {
    subscribers.delete(sub)
    try { res.end() } catch { /* already closed */ }
  }
}

/**
 * Broadcast an event to every connected subscriber. Failures on a
 * single subscriber are swallowed — that subscriber is removed.
 */
export function emit(event: RelayEvent): void {
  if (subscribers.size === 0) return
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const sub of subscribers) {
    try {
      sub.res.write(payload)
    } catch {
      subscribers.delete(sub)
    }
  }
}

/**
 * Periodic heartbeat keeps idle SSE connections from being killed by
 * intermediaries (browsers, proxies) that close silent streams.
 */
setInterval(() => {
  if (subscribers.size === 0) return
  emit({ type: 'heartbeat', sentAt: new Date().toISOString() })
}, HEARTBEAT_INTERVAL_MS)

export function subscriberCount(): number {
  return subscribers.size
}
