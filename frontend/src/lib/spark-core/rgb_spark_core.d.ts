/* tslint:disable */
/* eslint-disable */

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
 * Build a Non-Inflatable Asset (NIA) contract genesis programmatically
 * and return the deterministic 32-byte contractId as hex.
 *
 * The contractId is the canonical RGB identifier for the issued asset and
 * serves as the `msg` we bind a Spark leaf to via the Spark-UTK mint flow.
 * Same inputs always produce the same id (modulo `beneficiary_vout` and the
 * random nonce inside `GenesisSeal::new_random`, which IS non-deterministic;
 * callers wanting a reproducible id should round-trip the genesis instead).
 *
 * `ticker` / `name`: human-readable asset metadata (e.g. "TEST", "Test Asset").
 * `supply`: issued supply at genesis (allocated entirely to the beneficiary).
 * `beneficiary_txid_hex` / `beneficiary_vout`: the L1 outpoint that will
 * receive the asset at issuance. For Spark-UTK use, this is typically a
 * dummy/placeholder outpoint — we care about the contractId, not the seal.
 * `timestamp_secs`: unix timestamp for the genesis (caller-provided to
 * avoid relying on chrono's wasm time source).
 */
export function issueNiaContract(ticker: string, name: string, supply: bigint, beneficiary_txid_hex: string, beneficiary_vout: number, timestamp_secs: bigint): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_sparkutkproofjs_free: (a: number, b: number) => void;
    readonly deriveOutputXonly: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly deriveUTweaked: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly deriveVerifyingKey: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly issueNiaContract: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: bigint) => [number, number, number, number];
    readonly sparkutkproofjs_decode: (a: number, b: number) => [number, number, number];
    readonly sparkutkproofjs_encode: (a: number) => [number, number, number, number];
    readonly sparkutkproofjs_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly sparkutkproofjs_operator: (a: number) => [number, number];
    readonly sparkutkproofjs_uBase: (a: number) => [number, number];
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
