// Typed EventSource client for the rgb-spark relay's /events stream
// (Phase 1C/clean session 10). Push-based update path for the live
// trade ticker / orderbook depth / activity heatmap UX
// (RGB-SPK.md §4).
//
// Wire types kept in sync with `relay/src/events.ts` — adjust both.

export type RelayEvent =
  | {
      type: 'order_placed';
      assetId: string;
      orderId: string;
      side: 'ask' | 'bid';
      amount: string;
      priceSats: number;
      createdAt: string;
    }
  | {
      type: 'order_matched';
      assetId: string;
      orderId: string;
      counterpartyOrderId: string;
      matchedAmount: string;
      matchedAt: string;
    }
  | { type: 'order_cancelled'; assetId: string; orderId: string; cancelledAt: string }
  | { type: 'order_expired'; assetId: string; orderId: string; expiredAt: string }
  | { type: 'asset_registered'; assetId: string; firstSeenAt: string }
  | { type: 'heartbeat'; sentAt: string };

const DEFAULT_BASE = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? 'http://localhost:5180'
  : '/relay';

export interface SubscribeOpts {
  baseUrl?: string;
  /** Called with parsed events as they arrive. Heartbeats are also
   *  delivered; the caller may filter on `event.type === 'heartbeat'`
   *  to update a "last live" indicator. */
  onEvent: (event: RelayEvent) => void;
  /** Called on the underlying EventSource error event. The browser
   *  reconnects automatically; this is informational. */
  onError?: (err: Event) => void;
}

export interface Subscription {
  /** Close the SSE connection. After calling, no more onEvent calls. */
  close: () => void;
  /** Underlying readyState mirror — useful for UI status indicators. */
  readyState: () => 0 | 1 | 2;
}

/**
 * Open a persistent SSE subscription. The browser handles reconnection
 * automatically on transient network errors; on permanent failure
 * (relay down), `onError` fires and readyState stays at 0/2.
 */
export function subscribeEvents(opts: SubscribeOpts): Subscription {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const es = new EventSource(`${base}/events`);
  es.onmessage = (e: MessageEvent<string>) => {
    let parsed: RelayEvent;
    try {
      parsed = JSON.parse(e.data) as RelayEvent;
    } catch {
      return;
    }
    opts.onEvent(parsed);
  };
  if (opts.onError) {
    es.onerror = (e: Event) => { opts.onError!(e); };
  }
  return {
    close: () => es.close(),
    readyState: () => es.readyState as 0 | 1 | 2,
  };
}
