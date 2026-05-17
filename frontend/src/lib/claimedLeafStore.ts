// Claimed-leaf persistence for buyers (F2 of the trustless trade fix).
//
// When the buyer's `runBuyerFlow` claims the seller's asset leaf via
// `revealAndClaim`, it captures the leaf id that arrived in the
// wallet. That leaf carries the Spark-UTK keytweak bound to the
// seller's pre-trade RGB state — it's the ONLY leaf the buyer should
// later re-bind to the post-trade chain head. Re-binding any other
// vanilla leaf would let the buyer fake ownership of an asset they
// never actually paid for (atomicity hole).
//
// This store maps `paymentHash` → claimed leaf id, npub-scoped,
// localStorage-persisted. The settlement inbox consumes it when an
// RGB consignment for the matched HTLC arrives, and the consolidating
// rebind (`lazyRebindIfNeeded`) refuses to mint a bound leaf if no
// claimed leaf is registered — the trustless path stays closed.
//
// Storage posture mirrors orderPreimageStash: plain localStorage,
// npub-scoped. The leaf id itself isn't sensitive (it's already
// surfaced by the SDK's getLeaves response).

const STORAGE_KEY = 'rgbspark.claimedLeaves.v1';

export interface ClaimedLeafRecord {
  /** Hex-encoded 32-byte HTLC paymentHash. */
  paymentHashHex: string;
  /** Spark leaf id (uuid-ish string) that arrived as the claim result. */
  claimedLeafId: string;
  /** ISO timestamp — for stale-entry cleanup. */
  storedAt: string;
}

interface PersistedShape {
  npub: string;
  records: ClaimedLeafRecord[];
}

const state: { records: ClaimedLeafRecord[] } = { records: [] };
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
  if (state.records.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const payload: PersistedShape = { npub: currentNpub, records: state.records };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function attachClaimedLeaves(npub: string): void {
  currentNpub = npub;
  const persisted = readRaw();
  if (persisted && persisted.npub === npub) {
    state.records = persisted.records.slice();
  } else {
    state.records = [];
  }
}

export function detachClaimedLeaves(): void {
  currentNpub = null;
  state.records = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Idempotent on paymentHashHex — a second save for the same HTLC
 *  is a no-op so the inbox can't be tricked into rebinding to a
 *  different (potentially attacker-supplied) leaf for the same
 *  payment. */
export function recordClaimedLeaf(paymentHashHex: string, claimedLeafId: string): void {
  if (!currentNpub) {
    throw new Error(
      'recordClaimedLeaf: store not attached to a wallet. Call attachClaimedLeaves(npub) first.',
    );
  }
  const key = paymentHashHex.toLowerCase();
  if (state.records.some((r) => r.paymentHashHex === key)) return;
  state.records.push({
    paymentHashHex: key,
    claimedLeafId,
    storedAt: new Date().toISOString(),
  });
  writeRaw();
}

export function getClaimedLeaf(paymentHashHex: string): ClaimedLeafRecord | undefined {
  const key = paymentHashHex.toLowerCase();
  return state.records.find((r) => r.paymentHashHex === key);
}

/** Drop the record after the rebind consumes it. Keeps localStorage
 *  from growing unboundedly over many trades. */
export function removeClaimedLeaf(paymentHashHex: string): void {
  const key = paymentHashHex.toLowerCase();
  const before = state.records.length;
  state.records = state.records.filter((r) => r.paymentHashHex !== key);
  if (state.records.length !== before) writeRaw();
}

/** Diagnostic — list (paymentHash, leafId) pairs without exposing
 *  the full records to caller's log. */
export function listClaimedLeafKeys(): Array<{ paymentHashHex: string; claimedLeafId: string }> {
  return state.records.map((r) => ({
    paymentHashHex: r.paymentHashHex,
    claimedLeafId: r.claimedLeafId,
  }));
}
