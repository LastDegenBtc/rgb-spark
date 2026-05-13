// Typed client for the rgb-spark relay's asset registry routes
// (Phase 1C/clean session 9). Wire types kept in sync with
// `relay/src/registry.ts` — adjust both together.
//
// Same base-URL conventions as `orderbookRelay.ts` and
// `consignmentRelay.ts`: same-origin `/relay` by default, falls back
// to `http://localhost:5180` when running Vite directly on localhost.

export interface RegistryEntry {
  contractId: string;
  firstSeenAt: string;
  lastActivityAt: string;
  openOrdersCount: number;
  matchedOrdersCount: number;
  cancelledOrdersCount: number;
  expiredOrdersCount: number;
}

export type RegistrySortKey = 'lastActivityAt' | 'firstSeenAt' | 'matchedOrdersCount';

export class RegistryError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'RegistryError';
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
    throw new RegistryError(res.status, `registry ${res.status}: ${msg}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('json')) {
    throw new RegistryError(
      res.status,
      `registry returned non-JSON (content-type: ${ct || 'unset'}).`,
    );
  }
  return res.json();
}

export interface ListAssetsOpts {
  limit?: number;
  offset?: number;
  sortBy?: RegistrySortKey;
  baseUrl?: string;
}

/**
 * Paginated list of every asset the relay has ever seen via the
 * orderbook. Survives orderbook TTL — an asset that's been quiet for
 * 24+ h still shows up here as long as the relay process is up.
 */
export async function listAssets(opts?: ListAssetsOpts): Promise<RegistryEntry[]> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts?.sortBy !== undefined) params.set('sortBy', opts.sortBy);
  const qs = params.toString();
  const res = await fetch(url(opts?.baseUrl, `/registry/assets${qs ? '?' + qs : ''}`));
  return await jsonOrThrow(res) as RegistryEntry[];
}

export async function getAssetStats(
  contractId: string,
  opts?: { baseUrl?: string },
): Promise<RegistryEntry | null> {
  const res = await fetch(url(opts?.baseUrl, `/asset/${encodeURIComponent(contractId)}/stats`));
  if (res.status === 404) return null;
  return await jsonOrThrow(res) as RegistryEntry;
}
