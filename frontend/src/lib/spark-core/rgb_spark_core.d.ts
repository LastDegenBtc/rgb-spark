/* tslint:disable */
/* eslint-disable */

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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_niaissuance_free: (a: number, b: number) => void;
    readonly __wbg_niatransition_free: (a: number, b: number) => void;
    readonly __wbg_sparkutkproofjs_free: (a: number, b: number) => void;
    readonly buildNiaTransition: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number) => [number, number, number];
    readonly deriveOutputXonly: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly deriveUTweaked: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly deriveVerifyingKey: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly issueNiaContract: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: bigint) => [number, number, number];
    readonly niaissuance_consignmentHex: (a: number) => [number, number];
    readonly niaissuance_contractId: (a: number) => [number, number];
    readonly niatransition_commitIdHex: (a: number) => [number, number];
    readonly niatransition_transitionHex: (a: number) => [number, number];
    readonly sparkutkproofjs_decode: (a: number, b: number) => [number, number, number];
    readonly sparkutkproofjs_encode: (a: number) => [number, number, number, number];
    readonly sparkutkproofjs_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly sparkutkproofjs_operator: (a: number) => [number, number];
    readonly sparkutkproofjs_uBase: (a: number) => [number, number];
    readonly validateNiaConsignment: (a: number, b: number) => [number, number, number, number];
    readonly validateNiaTransition: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
