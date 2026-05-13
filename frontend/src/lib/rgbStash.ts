// Persistent RGB stash for rgb-spark.
//
// Stores NIA issuances + transitions client-side so an issuer can:
//   - Resurface a previously-issued contract after a reload (instead of
//     having to re-issue, which would change the contractId due to the
//     genesis nonce);
//   - Build chained transitions (T_n consuming T_{n-1}) without keeping
//     the bytes in memory across sessions.
//
// Storage: plain localStorage. RGB consignments are not secret (they're
// the bytes a sender ships to a receiver), so we don't PIN-encrypt — same
// reasoning as pathTweakStorage. Scoping by npub means a different wallet
// on the same device sees its own stash and not someone else's.
//
// In-memory shape mirrors the persisted shape closely; the only marshaling
// is at the localStorage boundary (JSON round-trip).

const STORAGE_KEY = 'rgbspark.rgbStash.v1';

/**
 * A NIA contract previously issued by this wallet, persisted in full so
 * we can rebuild a transition over it after a reload.
 */
export interface StashContract {
  /** 32-byte hex — the deterministic RGB contractId, used as Spark-UTK msg
   *  when this genesis is the binding target. Primary key. */
  contractId: string;
  ticker: string;
  name: string;
  /** Stored as decimal string for BigInt safety across the JSON boundary. */
  supply: string;
  /** Strict-encoded `Consignment<false>` bytes (hex). The same bytes that
   *  `core.issueNiaContract` returned and that `core.validateNiaConsignment`
   *  consumes — needed verbatim for receiver-side replay. */
  consignmentHex: string;
  createdAt: string;
}

/**
 * A NIA state transition built over a stash contract. Records both the
 * RGB-level commit_id (= Spark-UTK msg of the destination leaf) and a
 * back-pointer to the contract whose assignment it consumes, so we can
 * present transition chains in the UI.
 */
/**
 * Per-output allocation inside a NIA transition. v0 single-output
 * transitions have `outputs.length == 1`; partial-fill swaps from
 * Phase 1C/clean session 7.3 produce `outputs.length == 2` (buyer +
 * seller change).
 */
export interface StashTransitionOutput {
  /** Decimal-encoded u64 — units of the asset at this output. */
  amount: string;
}

export interface StashTransition {
  /** 32-byte hex — `transition.id()`, used as Spark-UTK msg of the leaf
   *  this transition is bound to. Primary key. */
  commitId: string;
  /** Back-pointer to the StashContract this transition consumes. */
  prevContractId: string;
  /** Per-output asset allocations, in transition.assignments[OS_ASSET]
   *  order. Length matches the number of outputs the transition
   *  produced. Index is the `consume_index` to pass to
   *  `buildNiaTransitionFromPrev` when consuming this transition next.
   *  Added in Phase 1C/clean session 7.3 — supersedes the prior single
   *  `amount` field. Legacy 1-output entries persisted before 7.3 are
   *  migrated in-memory to `outputs: [{amount}]` at attach time. */
  outputs: StashTransitionOutput[];
  /** Strict-encoded `Transition` bytes (hex). */
  transitionHex: string;
  createdAt: string;
}

interface PersistedShape {
  npub: string;
  contracts: StashContract[];
  transitions: StashTransition[];
}

const state: { contracts: StashContract[]; transitions: StashTransition[] } = {
  contracts: [],
  transitions: [],
};

let currentNpub: string | null = null;

type Listener = (snapshot: {
  contracts: StashContract[];
  transitions: StashTransition[];
}) => void;
const listeners = new Set<Listener>();

function snapshot() {
  return {
    contracts: state.contracts.slice(),
    transitions: state.transitions.slice(),
  };
}

function notify() {
  const snap = snapshot();
  for (const l of listeners) l(snap);
}

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
  if (state.contracts.length === 0 && state.transitions.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const payload: PersistedShape = {
    npub: currentNpub,
    contracts: state.contracts,
    transitions: state.transitions,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/**
 * Restore stash for the given npub from localStorage, then wire writes so
 * every subsequent mutation persists. Call once per wallet boot, after
 * the user is authenticated.
 *
 * If localStorage holds entries for a *different* npub, the in-memory
 * stash is cleared (the other wallet's data is left on disk but invisible)
 * — same posture as pathTweakStorage.
 */
export function attachStash(npub: string): void {
  currentNpub = npub;
  const persisted = readRaw();
  if (persisted && persisted.npub === npub) {
    state.contracts = persisted.contracts.slice();
    // Phase 1C/clean session 7.3 migration: legacy entries had a single
    // `amount: string` field; new entries carry `outputs: [{amount}]`.
    // Transparently convert legacy → new on load so the rest of the
    // codebase only deals with the new shape.
    state.transitions = persisted.transitions.map((t) => {
      const legacy = t as unknown as { amount?: string; outputs?: StashTransitionOutput[] };
      if (legacy.outputs && legacy.outputs.length > 0) return t;
      if (typeof legacy.amount === 'string') {
        return { ...t, outputs: [{ amount: legacy.amount }] };
      }
      // No usable amount info — drop. Shouldn't happen for any entry we
      // ever wrote; this branch exists only to defend against hand-edited
      // localStorage.
      return null as unknown as StashTransition;
    }).filter((t) => t !== null);
  } else {
    state.contracts = [];
    state.transitions = [];
  }
  notify();
}

/**
 * Disconnect the stash — call on wallet reset / forget. Clears in-memory
 * AND the localStorage entry.
 */
export function detachStash(): void {
  currentNpub = null;
  state.contracts = [];
  state.transitions = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private mode, etc); we've already
    // cleared in-memory which is the part that matters for security.
  }
  notify();
}

/** Idempotent on contractId — re-issuing the same contractId is a no-op. */
export function addContract(c: StashContract): void {
  if (state.contracts.some((x) => x.contractId === c.contractId)) return;
  state.contracts.push(c);
  writeRaw();
  notify();
}

/** Idempotent on commitId. */
export function addTransition(t: StashTransition): void {
  if (state.transitions.some((x) => x.commitId === t.commitId)) return;
  state.transitions.push(t);
  writeRaw();
  notify();
}

export function listContracts(): StashContract[] {
  return state.contracts.slice();
}

/**
 * Remove a contract + all its transitions from the stash. Used by the
 * UI to clean up orphan entries (= contracts whose mint flow failed
 * mid-way, leaving no bound leaf but a stash entry). No on-chain
 * effect — purely local stash cleanup. Idempotent: removing a
 * contract that doesn't exist is a no-op.
 */
export function removeContract(contractId: string): void {
  const id = contractId.toLowerCase();
  const beforeLen = state.contracts.length;
  state.contracts = state.contracts.filter((c) => c.contractId.toLowerCase() !== id);
  state.transitions = state.transitions.filter((t) => t.prevContractId.toLowerCase() !== id);
  if (state.contracts.length !== beforeLen) {
    writeRaw();
    notify();
  }
}

export function listTransitionsFor(contractId: string): StashTransition[] {
  return state.transitions.filter((t) => t.prevContractId === contractId);
}

export function getContractById(contractId: string): StashContract | undefined {
  return state.contracts.find((c) => c.contractId === contractId);
}

/** Subscribe to in-memory changes. Returns an unsubscribe function. */
export function subscribeStash(l: Listener): () => void {
  listeners.add(l);
  l(snapshot());
  return () => {
    listeners.delete(l);
  };
}
