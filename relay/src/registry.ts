// Asset registry — tracks every distinct RGB contractId ever observed
// via the orderbook (Phase 1C/clean session 9). Lives ABOVE the
// orderbook's per-asset TTL so the "what assets exist on this relay?"
// view doesn't disappear after 24 h of inactivity.
//
// State is in-memory only — restart wipes everything. Persistent
// registries are a later concern; for v0 the relay's role is still
// transport, not authoritative directory. A client that wants long-
// term asset memory keeps its own rgbStash.

import { emit } from './events.js'

/**
 * Single asset's lifetime stats. All counters are monotonically
 * incremented across the asset's lifetime (= as long as the relay
 * process is up). `openOrdersCount` is the only one that decrements,
 * via match / cancel / expiry transitions.
 */
export interface RegistryEntry {
  contractId: string
  firstSeenAt: string
  lastActivityAt: string
  openOrdersCount: number
  matchedOrdersCount: number
  cancelledOrdersCount: number
  expiredOrdersCount: number
}

const MAX_REGISTRY_SIZE = 10_000

const registry = new Map<string, RegistryEntry>()

function nowIso(): string {
  return new Date().toISOString()
}

function get(contractId: string): RegistryEntry | undefined {
  return registry.get(contractId.toLowerCase())
}

function ensure(contractId: string): RegistryEntry | null {
  const id = contractId.toLowerCase()
  const existing = registry.get(id)
  if (existing) return existing
  if (registry.size >= MAX_REGISTRY_SIZE) return null
  const fresh: RegistryEntry = {
    contractId: id,
    firstSeenAt: nowIso(),
    lastActivityAt: nowIso(),
    openOrdersCount: 0,
    matchedOrdersCount: 0,
    cancelledOrdersCount: 0,
    expiredOrdersCount: 0,
  }
  registry.set(id, fresh)
  // First-sight broadcast — drives the issuance feed UX (RGB-SPK §4.4).
  emit({ type: 'asset_registered', assetId: id, firstSeenAt: fresh.firstSeenAt })
  return fresh
}

/**
 * Call when a new order is accepted onto the orderbook AND its initial
 * status is `open`. Creates the registry entry on first sight + bumps
 * the open counter.
 */
export function noteOrderPlaced(contractId: string): void {
  const entry = ensure(contractId)
  if (!entry) return
  entry.openOrdersCount++
  entry.lastActivityAt = nowIso()
}

/**
 * Call once per order that flips to `matched`. On a fresh match the
 * placeOrder path calls this TWICE — once for the incoming order, once
 * for the resting counterparty — so the counters reflect both sides
 * transitioning.
 */
export function noteOrderMatched(contractId: string): void {
  const entry = get(contractId)
  if (!entry) return
  entry.matchedOrdersCount++
  if (entry.openOrdersCount > 0) entry.openOrdersCount--
  entry.lastActivityAt = nowIso()
}

export function noteOrderCancelled(contractId: string): void {
  const entry = get(contractId)
  if (!entry) return
  entry.cancelledOrdersCount++
  if (entry.openOrdersCount > 0) entry.openOrdersCount--
  entry.lastActivityAt = nowIso()
}

export function noteOrderExpired(contractId: string): void {
  const entry = get(contractId)
  if (!entry) return
  entry.expiredOrdersCount++
  if (entry.openOrdersCount > 0) entry.openOrdersCount--
  entry.lastActivityAt = nowIso()
}

export type RegistrySortKey = 'lastActivityAt' | 'firstSeenAt' | 'matchedOrdersCount'

export interface ListAssetsOpts {
  limit?: number
  offset?: number
  sortBy?: RegistrySortKey
}

/**
 * Paginated list. Default sort is most-recent-activity first — matches
 * the UX of an "active markets" feed. Pass sortBy='firstSeenAt' for the
 * "newly launched" feed, or 'matchedOrdersCount' for trending-by-volume.
 */
export function listAssets(opts?: ListAssetsOpts): RegistryEntry[] {
  const sortBy = opts?.sortBy ?? 'lastActivityAt'
  const limit = Math.max(0, Math.min(500, opts?.limit ?? 50))
  const offset = Math.max(0, opts?.offset ?? 0)
  const all = [...registry.values()]
  all.sort((a, b) => {
    if (sortBy === 'matchedOrdersCount') return b.matchedOrdersCount - a.matchedOrdersCount
    if (sortBy === 'firstSeenAt') return Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt)
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
  })
  return all.slice(offset, offset + limit)
}

export function getAssetStats(contractId: string): RegistryEntry | null {
  return get(contractId) ?? null
}

export function registryHealth(): { assets: number } {
  return { assets: registry.size }
}

// Visible for tests / dev tooling — never called from production code.
export function _clearRegistryForTest(): void {
  registry.clear()
}
