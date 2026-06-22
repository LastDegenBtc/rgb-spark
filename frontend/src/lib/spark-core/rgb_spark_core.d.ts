/* tslint:disable */
/* eslint-disable */

/**
 * JS handle around the human-readable + supply metadata extracted from a
 * validated NIA genesis. Lets the buyer-side inbox auto-populate the
 * `StashContract` shape without trusting the seller's envelope claims —
 * ticker, name, supply are all schema-validated bytes from the genesis.
 */
export class NiaGenesisMetadata {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly contractId: string;
    readonly name: string;
    /**
     * Decimal string. JS side parses as BigInt or compares as string.
     */
    readonly supply: string;
    readonly ticker: string;
}

/**
 * JS handle around the result of a NIA issuance — carries both the
 * deterministic contractId (the value we bind a Spark leaf to as `msg`)
 * AND the strict-encoded genesis consignment bytes (what a receiver
 * needs to validate the issuance client-side without trusting us).
 */
export class NiaIssuance {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly consignmentHex: string;
    readonly contractId: string;
}

/**
 * JS handle around the result of building a NIA `Transition`. Carries
 * both the strict-encoded transition bytes and `transition.id()` — the
 * 32-byte opid which the sender feeds into the receiver-side Spark-UTK
 * mint as `msg`, so the new leaf is cryptographically bound to *this*
 * specific RGB state-transition.
 */
export class NiaTransition {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commitIdHex: string;
    readonly transitionHex: string;
}

/**
 * JS handle around [`SparkUtkProof`]. Round-trips through the same
 * strict-encoding the rgb-consensus validator consumes.
 */
export class SparkUtkProofJs {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parse a strict-encoded `SparkUtkProof` (hex) back into a JS handle.
     */
    static decode(hex_str: string): SparkUtkProofJs;
    /**
     * Strict-encode the proof and return as hex. This is the on-the-wire
     * representation embedded in RGB consignments.
     */
    encode(): string;
    constructor(u_base_hex: string, operator_hex: string);
    readonly operator: string;
    readonly uBase: string;
}

/**
 * JS handle around the result of a UDA issuance — same shape as
 * `NiaIssuance`, but for a Unique Digital Asset (single indivisible
 * token, `OwnedFraction` of 1) genesis.
 */
export class UdaIssuance {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly consignmentHex: string;
    readonly contractId: string;
}

/**
 * Build a NIA `transfer` state transition consuming the `no`-th
 * `assetOwner` assignment of a previously issued genesis, allocating
 * `amount` units to a new beneficiary seal. Returns
 * `{ transitionHex, commitIdHex }` where `commitIdHex` is the
 * `transition.id()` to be used as `msg` for the receiver's Spark-UTK
 * mint.
 *
 * `genesis_hex`: strict-encoded `Consignment<false>` (genesis-only) as
 *                produced by `issueNiaContract`.
 * `consume_index`: which `assetOwner` output of the genesis to spend
 *                  (`0` for the single-output case our `issueNiaContract`
 *                  produces today).
 * `amount`: units to allocate to the beneficiary. Must equal the
 *           prior allocation's amount (`svs OS_ASSET` enforces
 *           conservation — no split/merge yet).
 * `beneficiary_txid_hex` / `beneficiary_vout`: the L1 outpoint that
 *           formally "owns" the new RGB allocation. Placeholder-safe
 *           in the Spark flow — never resolved on chain.
 */
export function buildNiaTransition(genesis_hex: string, consume_index: number, amount: bigint, beneficiary_txid_hex: string, beneficiary_vout: number): NiaTransition;

/**
 * Build a NIA transition consuming the `no`-th `assetOwner` assignment
 * of a PRIOR TRANSITION (not the genesis). The chain so far is
 * `genesis → prev_transition`; this builds the next link
 * `genesis → prev_transition → new_transition`.
 *
 * Used by the orderbook settlement flow: when a seller already has
 * a transition T_1 binding them to the asset, completing a swap means
 * producing T_2 that consumes T_1's output and allocates to the buyer
 * — without T_2 the buyer has no chain-of-ownership artifact even if
 * the Spark leaf is transferred via HTLC.
 *
 * `prev_transition_hex`: strict-encoded `Transition` (= prior link in
 *                        the chain).
 * `prev_genesis_hex`: the `Consignment<false>` of the contract's
 *                     genesis (needed to recover contractId; for
 *                     conservation checks the WASM schema validator
 *                     in `validateNiaTransitionFromPrev` also re-runs
 *                     the genesis through `validate_state`).
 * `consume_index`: which assetOwner output of `prev_transition` to
 *                  spend. `0` for the single-output case our
 *                  `buildNiaTransition` produces.
 * `amount`: must equal the prior allocation's amount (`svs OS_ASSET`
 *           conservation — no split/merge yet at this layer).
 */
export function buildNiaTransitionFromPrev(prev_transition_hex: string, prev_genesis_hex: string, consume_index: number, amount: bigint, beneficiary_txid_hex: string, beneficiary_vout: number): NiaTransition;

/**
 * Build a NIA `transfer` transition that MERGES N inputs (from any
 * number of distinct prior transitions) into a single output allocation
 * equal to the sum of input amounts. Load-bearing primitive for the
 * wallet's `lazyRebindIfNeeded` consolidation path: a buyer who
 * accumulated two separate per-trade allocations (e.g. 1000 + 2000)
 * fuses them into one fresh leaf carrying the total (3000).
 *
 * Parallel arrays `prev_transitions_hex` / `consume_indices` /
 * `amounts_dec` MUST have equal length (== number of inputs). Each
 * triple `(prev_transitions_hex[i], consume_indices[i], amounts_dec[i])`
 * describes one input: the prior transition to consume from, the
 * output index within it, and the amount allocated at that output.
 * The function cross-checks `amounts_dec[i]` against the prior
 * transition's actual stored value and fails fast on mismatch.
 *
 * `amounts_dec` are decimal-encoded u64 strings (dodge JS Number
 * precision for amounts > 2^53). The output is `sum(amounts_dec)`.
 *
 * The schema validator independently enforces conservation
 * (`sum(in) == sum(out)`) via AluVM. The pre-check here is a friendly
 * error path for caller mistakes, not the trust boundary.
 */
export function buildNiaTransitionMerge(prev_genesis_hex: string, prev_transitions_hex: string[], consume_indices: Uint32Array, amounts_dec: string[], beneficiary_txid_hex: string, beneficiary_vout: number): NiaTransition;

/**
 * Multi-output sibling of `buildNiaTransition`. Builds a NIA
 * `transfer` transition consuming the `no`-th genesis assetOwner
 * assignment and allocating to N beneficiary seals with arbitrary
 * per-output amounts. The schema validator enforces `sum(out) ==
 * sum(in)` via AluVM; we also pre-check it here to fail fast on
 * caller mistakes.
 *
 * Parallel arrays `amounts_dec` / `beneficiary_txids_hex` /
 * `beneficiary_vouts` MUST have equal length (== number of outputs).
 * `amounts_dec` values are decimal-encoded u64 strings (dodge JS
 * Number precision for amounts > 2^53).
 *
 * This is the load-bearing primitive for split-merge support in
 * RGB-SPK (Phase 1C/clean session 7.1): fractional ownership requires
 * that one transition assigns N units to a buyer and M units back to
 * the seller as change. `buildNiaTransition` (the 1-output API) stays
 * in place for backward compatibility while the wallet migrates.
 */
export function buildNiaTransitionMultiOutput(genesis_hex: string, consume_index: number, amounts_dec: string[], beneficiary_txids_hex: string[], beneficiary_vouts: Uint32Array): NiaTransition;

/**
 * Multi-output sibling of `buildNiaTransitionFromPrev`. Same shape
 * as `buildNiaTransitionMultiOutput` but consumes a prior transition's
 * output instead of the genesis. Used in the orderbook settlement path
 * when the seller's pre-swap leaf carries more units than the order
 * amount — one output goes to the buyer, one back to the seller as
 * change.
 */
export function buildNiaTransitionMultiOutputFromPrev(prev_transition_hex: string, prev_genesis_hex: string, consume_index: number, amounts_dec: string[], beneficiary_txids_hex: string[], beneficiary_vouts: Uint32Array): NiaTransition;

/**
 * Derive the L1 unilateral-exit BIP-341 noscript x-only output key.
 * Returns a 32-byte x-only pubkey (hex) — the same value that would
 * appear in the leaf's `verifyingKey`-tweaked p2tr output.
 */
export function deriveOutputXonly(u_base_hex: string, commitment_hex: string, operator_hex: string): string;

/**
 * Derive `U_tweaked = U_base + t·G`, with
 * `t = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)`.
 *
 * `u_base_hex`: 33-byte compressed secp256k1 pubkey.
 * `msg_hex`: 32-byte RGB Merkle commitment.
 * Returns the tweaked 33-byte compressed pubkey (hex).
 */
export function deriveUTweaked(u_base_hex: string, msg_hex: string): string;

/**
 * Derive the Spark leaf's `verifyingKey = U_tweaked + operator`.
 * Returns a 33-byte compressed pubkey (hex).
 */
export function deriveVerifyingKey(u_base_hex: string, msg_hex: string, operator_hex: string): string;

/**
 * Build a Non-Inflatable Asset (NIA) contract genesis programmatically.
 *
 * Returns `{ contractId, consignmentHex }`:
 *   - `contractId`: 32-byte hex, the canonical RGB identifier — fed into
 *     the Spark-UTK mint as `msg` so the leaf commits to this asset.
 *   - `consignmentHex`: strict-encoded `Consignment<false>` bytes — sent
 *     to the receiver alongside the Spark-UTK proof so they can validate
 *     the issuance client-side via `validateNiaConsignment` below.
 *
 * `ticker` / `name`: human-readable metadata.
 * `supply`: issued supply (allocated entirely to the beneficiary).
 * `beneficiary_txid_hex` / `beneficiary_vout`: the L1 outpoint that will
 * receive the asset at issuance. For UTK msg-binding use, a placeholder
 * is fine — what matters is the deterministic contractId.
 * `timestamp_secs`: unix timestamp for the genesis (caller-provided to
 * avoid chrono's wasm time path).
 */
export function issueNiaContract(ticker: string, name: string, supply: bigint, beneficiary_txid_hex: string, beneficiary_vout: number, timestamp_secs: bigint): NiaIssuance;

/**
 * Build a Unique Digital Asset (UDA) contract genesis programmatically.
 *
 * Returns `{ contractId, consignmentHex }` — same usage as
 * `issueNiaContract`: `contractId` is fed into the Spark-UTK mint as
 * `msg`, `consignmentHex` lets the receiver validate the issuance
 * client-side via `validateNiaConsignment` (shares `NonInflatableAsset`'s
 * confined-bytes layout, but must be checked against
 * `UniqueDigitalAsset::types()` instead).
 *
 * `ticker` / `name`: human-readable asset metadata (UDA spec, not the
 * per-token name). `token_index`: the UDA's `TokenIndex` — 0 for a
 * single-token issuance. A UDA always mints exactly one indivisible
 * unit (`OwnedFraction` of 1), so there is no `supply` parameter.
 * `beneficiary_txid_hex` / `beneficiary_vout`: the L1 outpoint that
 * will receive the token at issuance.
 * `timestamp_secs`: unix timestamp for the genesis (caller-provided to
 * avoid chrono's wasm time path).
 */
export function issueUdaContract(ticker: string, name: string, token_index: number, beneficiary_txid_hex: string, beneficiary_vout: number, timestamp_secs: bigint): UdaIssuance;

/**
 * Decode a NIA genesis consignment and extract the metadata fields a
 * receiver needs to register the contract in their rgbStash without
 * trusting the sender. Re-validates the consignment internally, so any
 * caller can pass arbitrary bytes from the wire without a prior check.
 *
 * Returns `{contractId, ticker, name, supply}`. The `supply` value comes
 * back as a decimal string (u64 outside JS Number's safe-integer range
 * would silently truncate otherwise).
 */
export function niaGenesisMetadata(consignment_hex: string): NiaGenesisMetadata;

/**
 * Return a transition's inputs as parallel `(op_hex, no)` arrays.
 * `op_hex_out[i]` is the 32-byte hex opid the i-th input consumes;
 * `no_out[i]` is the output index within that op. Insertion order
 * matches the strict-encoded inputs set. Unlike `niaTransitionPrevOpids`
 * this preserves per-input granularity (op AND no) so the caller can
 * check whether a specific `(op, no)` was subsequently consumed — the
 * load-bearing check for "is this allocation still live?" in the
 * wallet's balance summation.
 *
 * Returns `[op_hex_array, no_strings_array]`: a 2-element wrapper so
 * callers can zip the parallel arrays. `no` is stringified because
 * wasm-bindgen's structured return types are heavyweight; the caller
 * JS does `Number(s)`.
 */
export function niaTransitionInputs(transition_hex: string): string[];

/**
 * Extract the per-output asset amounts from a strict-encoded NIA
 * `Transition` (hex). Returns one decimal string per output,
 * indexed by the output's position in `transition.assignments[OS_ASSET]`.
 *
 * Trustless replacement for "trust the sender's envelope claim about
 * who got what": the receiver decodes the transition bytes themselves
 * and reads the amounts the schema validator just signed off on.
 *
 * `transition_hex`: strict-encoded `Transition` (= what
 * `buildNiaTransition*` produces).
 *
 * Decimal strings (not `u64` directly) for the same JS-Number-
 * precision reason as `niaGenesisMetadata.supply`.
 */
export function niaTransitionOutputs(transition_hex: string): string[];

/**
 * Return the distinct opids (32-byte hex) that a transition consumes
 * — one entry per unique `input.op`, stable insertion order. For a
 * linear single-input transition this returns a 1-element vec; for
 * a multi-input merge it returns N. The caller (typically the
 * settlement inbox in the wallet frontend) uses these to walk a chain
 * backwards through local stash entries until reaching the genesis
 * opid, then hands the ordered chain to `validateNiaChain`.
 */
export function niaTransitionPrevOpids(transition_hex: string): string[];

/**
 * Validate an arbitrary-depth NIA chain: genesis → T_1 → T_2 → … → T_n.
 *
 * `chain_transitions_hex` is the ordered list of transitions starting
 * from the one that consumes from the genesis (T_1) and ending with
 * the newest (T_n). The validator re-runs the rgb-consensus schema
 * check on every link AND verifies each link consumes from the prior
 * op in the chain (genesis for T_1, T_{i-1} for T_i). Returns
 * `T_n.id()` if everything validates.
 *
 * Supports only linear chains: every input of T_i must point at the
 * same prior opid (T_{i-1}). Multi-input merges and DAG branches are
 * rejected with an explicit error so the caller can fall back. For a
 * single-link chain this is equivalent to `validateNiaTransition`;
 * for a two-link chain it matches `validateNiaTransitionFromPrev`.
 *
 * Same trust posture as the other validators: no L1 witness, no
 * `ResolveWitness` — Spark replaces the transport layer (see
 * `feedback_no_synthetic_l1_witness`).
 */
export function validateNiaChain(chain_transitions_hex: string[], prev_genesis_hex: string): string;

/**
 * Decode + validate a strict-encoded NIA genesis consignment (hex).
 * Returns the contractId (32-byte hex) extracted from the validated
 * consignment, so the receiver can compare it against the `msgHex`
 * the Spark-UTK proof was bound to. Validation runs the full
 * rgb-consensus pipeline against `NonInflatableAsset::types()` as the
 * trusted typesystem — i.e. the receiver verifies the asset against
 * the canonical NIA schema, not a sender-supplied one.
 *
 * Uses `NoResolver` because a genesis-only consignment has no witness
 * transactions to look up; transition consignments (chunk-γ session 2+)
 * will need a real resolver.
 */
export function validateNiaConsignment(consignment_hex: string): string;

/**
 * Validate an arbitrary-shape NIA DAG: a topologically-sorted set of
 * transitions where each input may reference the genesis OR any
 * earlier transition in the array. Supports both linear chains (every
 * `T_i` consumes only `T_{i-1}`) and merges (a `T_i` consumes multiple
 * earlier ops simultaneously) — superset of `validateNiaChain`. Returns
 * `transitions[transitions.len() - 1].id()` if every link validates.
 *
 * Topo order is required: for every input `(op, no)` of `transitions[i]`,
 * `op` must equal `genesis.id()` or `transitions[j].id()` for some
 * `j < i`. Out-of-order inputs are rejected. Duplicate transitions in
 * the array are not allowed.
 *
 * Use case: the wallet's `lazyRebindIfNeeded` produces a merge
 * transition that consumes multiple earlier per-trade allocations
 * (e.g. `1000` + `2000` → one fresh `3000` leaf at the new chain head).
 * The buyer-side inbox accepts the resulting envelope by reconstructing
 * every contributing chain from local stash, concatenating them into a
 * single topologically-sorted array, appending the merge transition,
 * and handing the result to this function.
 *
 * Same trust posture as the other validators: no L1 witness, no
 * `ResolveWitness` — Spark replaces the transport layer.
 */
export function validateNiaDag(transitions_hex: string[], prev_genesis_hex: string): string;

/**
 * Validate a strict-encoded NIA `Transition` (hex) against its prior
 * `Consignment<false>` (genesis, hex). Returns `transition.id()` as
 * 32-byte hex — the value the receiver compares with `msgHex` to
 * confirm the new leaf's Spark-UTK binding refers to *this* specific
 * transition.
 *
 * This is the Spark-native path: we run the rgb-consensus schema
 * validator (typesystem checks + AluVM `svs OS_ASSET` conservation
 * check) on the transition in isolation, with the input state map
 * built deterministically from the genesis assignments. We do NOT
 * go through `Validator::validate_bundles`, which would require a
 * `ResolveWitness` impl pointing at an L1 commitment — Spark replaces
 * the L1 transport, see [feedback_no_synthetic_l1_witness].
 */
export function validateNiaTransition(transition_hex: string, genesis_hex: string): string;

/**
 * Validate a NIA transition chain of length 3: genesis → prev_transition
 * → transition. Re-runs the rgb-consensus schema validator on every
 * link (genesis schema check, prev_transition consumed-from-genesis
 * check, transition consumed-from-prev_transition check) and returns
 * `transition.id()` if all three validate.
 *
 * Same trust posture as `validateNiaTransition`: no L1 witness, no
 * `ResolveWitness` — Spark replaces the transport layer (see
 * `feedback_no_synthetic_l1_witness`). Witness metadata fed to
 * `OrdOpRef::Transition(...)` is `strict_dumb` because the NIA AluVM
 * scripts only inspect input/output assignments, never the witness
 * txid.
 */
export function validateNiaTransitionFromPrev(transition_hex: string, prev_transition_hex: string, prev_genesis_hex: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_niagenesismetadata_free: (a: number, b: number) => void;
    readonly __wbg_niaissuance_free: (a: number, b: number) => void;
    readonly __wbg_niatransition_free: (a: number, b: number) => void;
    readonly __wbg_sparkutkproofjs_free: (a: number, b: number) => void;
    readonly __wbg_udaissuance_free: (a: number, b: number) => void;
    readonly buildNiaTransition: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number) => [number, number, number];
    readonly buildNiaTransitionFromPrev: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number, i: number) => [number, number, number];
    readonly buildNiaTransitionMerge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly buildNiaTransitionMultiOutput: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly buildNiaTransitionMultiOutputFromPrev: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly deriveOutputXonly: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly deriveUTweaked: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly deriveVerifyingKey: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly issueNiaContract: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: bigint) => [number, number, number];
    readonly issueUdaContract: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint) => [number, number, number];
    readonly niaGenesisMetadata: (a: number, b: number) => [number, number, number];
    readonly niaTransitionInputs: (a: number, b: number) => [number, number, number, number];
    readonly niaTransitionOutputs: (a: number, b: number) => [number, number, number, number];
    readonly niaTransitionPrevOpids: (a: number, b: number) => [number, number, number, number];
    readonly niagenesismetadata_contractId: (a: number) => [number, number];
    readonly niagenesismetadata_name: (a: number) => [number, number];
    readonly niagenesismetadata_supply: (a: number) => [number, number];
    readonly niagenesismetadata_ticker: (a: number) => [number, number];
    readonly niaissuance_consignmentHex: (a: number) => [number, number];
    readonly niaissuance_contractId: (a: number) => [number, number];
    readonly niatransition_commitIdHex: (a: number) => [number, number];
    readonly niatransition_transitionHex: (a: number) => [number, number];
    readonly sparkutkproofjs_decode: (a: number, b: number) => [number, number, number];
    readonly sparkutkproofjs_encode: (a: number) => [number, number, number, number];
    readonly sparkutkproofjs_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly sparkutkproofjs_operator: (a: number) => [number, number];
    readonly sparkutkproofjs_uBase: (a: number) => [number, number];
    readonly udaissuance_consignmentHex: (a: number) => [number, number];
    readonly udaissuance_contractId: (a: number) => [number, number];
    readonly validateNiaChain: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly validateNiaConsignment: (a: number, b: number) => [number, number, number, number];
    readonly validateNiaDag: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly validateNiaTransition: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly validateNiaTransitionFromPrev: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
