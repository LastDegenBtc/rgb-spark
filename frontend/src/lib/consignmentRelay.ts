// Typed client for the rgb-spark consignment relay (`relay/src/index.ts`).
//
// Default base URL is same-origin `/relay`, matched by the nginx reverse
// proxy block in `/etc/nginx/sites-available/lab.pprgb.app`. Override via
// `baseUrl` in each call (useful for cross-origin / standalone testing).
//
// The wire format is opaque to the relay — it just routes bytes by recipient
// npub. We treat them as Uint8Array end-to-end and let the caller decide
// what's inside (raw SparkUtkProof bytes, JSON envelope, encrypted blob, …).

export interface ConsignmentMeta {
  id: string
  size: number
  receivedAt: string
}

export interface RelayHealth {
  ok: boolean
  npubs: number
  pending: number
}

export class RelayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'RelayError'
  }
}

// Default to same-origin `/relay` (nginx-proxied). When the page is served
// directly from Vite at localhost:5173 (no nginx in front), there's no
// /relay/ proxy — fall back to the relay's direct port. CORS is open
// server-side, so cross-origin works without preflight headaches.
const DEFAULT_BASE = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? 'http://localhost:5180'
  : '/relay'

function url(base: string | undefined, path: string): string {
  return `${base ?? DEFAULT_BASE}${path}`
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = await res.json() as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new RelayError(res.status, `relay ${res.status}: ${msg}`)
  }
  // Defensive: if /relay/ is not proxied by nginx, Vite's SPA fallback returns
  // its index.html at 200 OK. `.json()` on that HTML throws an opaque
  // "string did not match" in WebKit — give the caller a clearer diagnosis.
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().includes('json')) {
    throw new RelayError(
      res.status,
      `relay returned non-JSON (content-type: ${ct || 'unset'}). ` +
      `Is /relay/ proxied to the consignment relay? See relay/ + nginx site config.`,
    )
  }
  return res.json()
}

export async function checkRelayHealth(opts?: { baseUrl?: string }): Promise<RelayHealth> {
  const res = await fetch(url(opts?.baseUrl, `/healthz`), { method: 'GET' })
  return await jsonOrThrow(res) as RelayHealth
}

export async function postConsignment(
  npub: string,
  bytes: Uint8Array,
  opts?: { baseUrl?: string },
): Promise<ConsignmentMeta> {
  // Copy into a fresh Uint8Array<ArrayBuffer> so fetch's body accepts it
  // regardless of the source buffer's `ArrayBufferLike` typing.
  const body = new Uint8Array(bytes)
  const res = await fetch(url(opts?.baseUrl, `/consignment/${encodeURIComponent(npub)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  })
  return await jsonOrThrow(res) as ConsignmentMeta
}

export async function listConsignments(
  npub: string,
  opts?: { baseUrl?: string },
): Promise<ConsignmentMeta[]> {
  const res = await fetch(url(opts?.baseUrl, `/consignment/${encodeURIComponent(npub)}`), { method: 'GET' })
  return await jsonOrThrow(res) as ConsignmentMeta[]
}

export async function fetchConsignment(
  npub: string,
  id: string,
  opts?: { baseUrl?: string },
): Promise<Uint8Array> {
  const res = await fetch(
    url(opts?.baseUrl, `/consignment/${encodeURIComponent(npub)}/${encodeURIComponent(id)}`),
    { method: 'GET' },
  )
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = await res.json() as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new RelayError(res.status, `relay ${res.status}: ${msg}`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

export async function ackConsignment(
  npub: string,
  id: string,
  opts?: { baseUrl?: string },
): Promise<void> {
  const res = await fetch(
    url(opts?.baseUrl, `/consignment/${encodeURIComponent(npub)}/${encodeURIComponent(id)}`),
    { method: 'DELETE' },
  )
  if (!res.ok && res.status !== 204) {
    let msg = res.statusText
    try {
      const body = await res.json() as { error?: string }
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new RelayError(res.status, `relay ${res.status}: ${msg}`)
  }
}
