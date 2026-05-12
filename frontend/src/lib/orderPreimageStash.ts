// Order-preimage persistence for sellers (Phase 1C session 3).
//
// When a seller places an ask, they generate a preimage P locally and
// publish only `paymentHash = sha256(P)` in the order. The preimage
// must survive any reload between placement and match — without it,
// the seller can't fire `runSellerFlow` to claim the buyer's sats.
//
// Storage: plain localStorage, npub-scoped, same posture as pathTweakStorage
// and rgbStash. Preimages aren't sensitive in the standard HTLC threat
// model — they're values whose ONLY power is "claim the leaves locked
// under sha256(P)". An attacker reading the preimage from localStorage
// already has wallet-level access, in which case they don't need the
// preimage to steal funds.

const STORAGE_KEY = 'rgbspark.orderSecrets.v1';

export interface OrderSecret {
  /** uuid v7 of the order this preimage belongs to. */
  orderId: string;
  /** 64-hex preimage. sha256(this) === paymentHash on the matched order. */
  preimageHex: string;
  /** ISO timestamp — for cleanup of stale entries past the order's TTL. */
  storedAt: string;
}

interface PersistedShape {
  npub: string;
  secrets: OrderSecret[];
}

const state: { secrets: OrderSecret[] } = { secrets: [] };
let currentNpub: string | null = null;

function readRaw(): PersistedShape | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedShape;
  } catch {
    return null;
  }
}

function writeRaw(): void {
  if (!currentNpub) return;
  if (state.secrets.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const payload: PersistedShape = { npub: currentNpub, secrets: state.secrets };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function attachOrderSecrets(npub: string): void {
  currentNpub = npub;
  const persisted = readRaw();
  if (persisted && persisted.npub === npub) {
    state.secrets = persisted.secrets.slice();
  } else {
    state.secrets = [];
  }
}

export function detachOrderSecrets(): void {
  currentNpub = null;
  state.secrets = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Save the preimage for an order. Idempotent on orderId — a second save
 * with the same id is a no-op. This protects against accidentally
 * overwriting the secret if the same order id is re-emitted.
 */
export function addOrderSecret(orderId: string, preimageHex: string): void {
  if (state.secrets.some((s) => s.orderId === orderId)) return;
  state.secrets.push({
    orderId,
    preimageHex,
    storedAt: new Date().toISOString(),
  });
  writeRaw();
}

export function getOrderSecret(orderId: string): OrderSecret | undefined {
  return state.secrets.find((s) => s.orderId === orderId);
}

/** Drop a specific secret. Use after the swap completes or the order expires. */
export function removeOrderSecret(orderId: string): void {
  const before = state.secrets.length;
  state.secrets = state.secrets.filter((s) => s.orderId !== orderId);
  if (state.secrets.length !== before) writeRaw();
}

/** Diagnostic helper — list how many secrets are persisted. Returned shape
 *  intentionally hides the preimages to avoid accidental log leakage; the
 *  raw access goes via getOrderSecret(orderId) only. */
export function listOrderSecretIds(): string[] {
  return state.secrets.map((s) => s.orderId);
}
