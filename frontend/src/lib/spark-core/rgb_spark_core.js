/* @ts-self-types="./rgb_spark_core.d.ts" */

/**
 * JS handle around the human-readable + supply metadata extracted from a
 * validated NIA genesis. Lets the buyer-side inbox auto-populate the
 * `StashContract` shape without trusting the seller's envelope claims —
 * ticker, name, supply are all schema-validated bytes from the genesis.
 */
export class NiaGenesisMetadata {
    static __wrap(ptr) {
        const obj = Object.create(NiaGenesisMetadata.prototype);
        obj.__wbg_ptr = ptr;
        NiaGenesisMetadataFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NiaGenesisMetadataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_niagenesismetadata_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get contractId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niagenesismetadata_contractId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niagenesismetadata_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Decimal string. JS side parses as BigInt or compares as string.
     * @returns {string}
     */
    get supply() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niagenesismetadata_supply(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get ticker() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niagenesismetadata_ticker(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) NiaGenesisMetadata.prototype[Symbol.dispose] = NiaGenesisMetadata.prototype.free;

/**
 * JS handle around the result of a NIA issuance — carries both the
 * deterministic contractId (the value we bind a Spark leaf to as `msg`)
 * AND the strict-encoded genesis consignment bytes (what a receiver
 * needs to validate the issuance client-side without trusting us).
 */
export class NiaIssuance {
    static __wrap(ptr) {
        const obj = Object.create(NiaIssuance.prototype);
        obj.__wbg_ptr = ptr;
        NiaIssuanceFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NiaIssuanceFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_niaissuance_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get consignmentHex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niaissuance_consignmentHex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get contractId() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niaissuance_contractId(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) NiaIssuance.prototype[Symbol.dispose] = NiaIssuance.prototype.free;

/**
 * JS handle around the result of building a NIA `Transition`. Carries
 * both the strict-encoded transition bytes and `transition.id()` — the
 * 32-byte opid which the sender feeds into the receiver-side Spark-UTK
 * mint as `msg`, so the new leaf is cryptographically bound to *this*
 * specific RGB state-transition.
 */
export class NiaTransition {
    static __wrap(ptr) {
        const obj = Object.create(NiaTransition.prototype);
        obj.__wbg_ptr = ptr;
        NiaTransitionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NiaTransitionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_niatransition_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get commitIdHex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niatransition_commitIdHex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get transitionHex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.niatransition_transitionHex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) NiaTransition.prototype[Symbol.dispose] = NiaTransition.prototype.free;

/**
 * JS handle around [`SparkUtkProof`]. Round-trips through the same
 * strict-encoding the rgb-consensus validator consumes.
 */
export class SparkUtkProofJs {
    static __wrap(ptr) {
        const obj = Object.create(SparkUtkProofJs.prototype);
        obj.__wbg_ptr = ptr;
        SparkUtkProofJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SparkUtkProofJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sparkutkproofjs_free(ptr, 0);
    }
    /**
     * Parse a strict-encoded `SparkUtkProof` (hex) back into a JS handle.
     * @param {string} hex_str
     * @returns {SparkUtkProofJs}
     */
    static decode(hex_str) {
        const ptr0 = passStringToWasm0(hex_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sparkutkproofjs_decode(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SparkUtkProofJs.__wrap(ret[0]);
    }
    /**
     * Strict-encode the proof and return as hex. This is the on-the-wire
     * representation embedded in RGB consignments.
     * @returns {string}
     */
    encode() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.sparkutkproofjs_encode(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} u_base_hex
     * @param {string} operator_hex
     */
    constructor(u_base_hex, operator_hex) {
        const ptr0 = passStringToWasm0(u_base_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(operator_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sparkutkproofjs_new(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        SparkUtkProofJsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {string}
     */
    get operator() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sparkutkproofjs_operator(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get uBase() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sparkutkproofjs_uBase(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) SparkUtkProofJs.prototype[Symbol.dispose] = SparkUtkProofJs.prototype.free;

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
 * @param {string} genesis_hex
 * @param {number} consume_index
 * @param {bigint} amount
 * @param {string} beneficiary_txid_hex
 * @param {number} beneficiary_vout
 * @returns {NiaTransition}
 */
export function buildNiaTransition(genesis_hex, consume_index, amount, beneficiary_txid_hex, beneficiary_vout) {
    const ptr0 = passStringToWasm0(genesis_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(beneficiary_txid_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.buildNiaTransition(ptr0, len0, consume_index, amount, ptr1, len1, beneficiary_vout);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return NiaTransition.__wrap(ret[0]);
}

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
 * @param {string} prev_transition_hex
 * @param {string} prev_genesis_hex
 * @param {number} consume_index
 * @param {bigint} amount
 * @param {string} beneficiary_txid_hex
 * @param {number} beneficiary_vout
 * @returns {NiaTransition}
 */
export function buildNiaTransitionFromPrev(prev_transition_hex, prev_genesis_hex, consume_index, amount, beneficiary_txid_hex, beneficiary_vout) {
    const ptr0 = passStringToWasm0(prev_transition_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(prev_genesis_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(beneficiary_txid_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.buildNiaTransitionFromPrev(ptr0, len0, ptr1, len1, consume_index, amount, ptr2, len2, beneficiary_vout);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return NiaTransition.__wrap(ret[0]);
}

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
 * @param {string} genesis_hex
 * @param {number} consume_index
 * @param {string[]} amounts_dec
 * @param {string[]} beneficiary_txids_hex
 * @param {Uint32Array} beneficiary_vouts
 * @returns {NiaTransition}
 */
export function buildNiaTransitionMultiOutput(genesis_hex, consume_index, amounts_dec, beneficiary_txids_hex, beneficiary_vouts) {
    const ptr0 = passStringToWasm0(genesis_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(amounts_dec, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayJsValueToWasm0(beneficiary_txids_hex, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(beneficiary_vouts, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.buildNiaTransitionMultiOutput(ptr0, len0, consume_index, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return NiaTransition.__wrap(ret[0]);
}

/**
 * Multi-output sibling of `buildNiaTransitionFromPrev`. Same shape
 * as `buildNiaTransitionMultiOutput` but consumes a prior transition's
 * output instead of the genesis. Used in the orderbook settlement path
 * when the seller's pre-swap leaf carries more units than the order
 * amount — one output goes to the buyer, one back to the seller as
 * change.
 * @param {string} prev_transition_hex
 * @param {string} prev_genesis_hex
 * @param {number} consume_index
 * @param {string[]} amounts_dec
 * @param {string[]} beneficiary_txids_hex
 * @param {Uint32Array} beneficiary_vouts
 * @returns {NiaTransition}
 */
export function buildNiaTransitionMultiOutputFromPrev(prev_transition_hex, prev_genesis_hex, consume_index, amounts_dec, beneficiary_txids_hex, beneficiary_vouts) {
    const ptr0 = passStringToWasm0(prev_transition_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(prev_genesis_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayJsValueToWasm0(amounts_dec, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayJsValueToWasm0(beneficiary_txids_hex, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray32ToWasm0(beneficiary_vouts, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.buildNiaTransitionMultiOutputFromPrev(ptr0, len0, ptr1, len1, consume_index, ptr2, len2, ptr3, len3, ptr4, len4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return NiaTransition.__wrap(ret[0]);
}

/**
 * Derive the L1 unilateral-exit BIP-341 noscript x-only output key.
 * Returns a 32-byte x-only pubkey (hex) — the same value that would
 * appear in the leaf's `verifyingKey`-tweaked p2tr output.
 * @param {string} u_base_hex
 * @param {string} commitment_hex
 * @param {string} operator_hex
 * @returns {string}
 */
export function deriveOutputXonly(u_base_hex, commitment_hex, operator_hex) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(u_base_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(commitment_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(operator_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.deriveOutputXonly(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Derive `U_tweaked = U_base + t·G`, with
 * `t = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)`.
 *
 * `u_base_hex`: 33-byte compressed secp256k1 pubkey.
 * `msg_hex`: 32-byte RGB Merkle commitment.
 * Returns the tweaked 33-byte compressed pubkey (hex).
 * @param {string} u_base_hex
 * @param {string} msg_hex
 * @returns {string}
 */
export function deriveUTweaked(u_base_hex, msg_hex) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(u_base_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(msg_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.deriveUTweaked(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Derive the Spark leaf's `verifyingKey = U_tweaked + operator`.
 * Returns a 33-byte compressed pubkey (hex).
 * @param {string} u_base_hex
 * @param {string} msg_hex
 * @param {string} operator_hex
 * @returns {string}
 */
export function deriveVerifyingKey(u_base_hex, msg_hex, operator_hex) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(u_base_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(msg_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(operator_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.deriveVerifyingKey(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

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
 * @param {string} ticker
 * @param {string} name
 * @param {bigint} supply
 * @param {string} beneficiary_txid_hex
 * @param {number} beneficiary_vout
 * @param {bigint} timestamp_secs
 * @returns {NiaIssuance}
 */
export function issueNiaContract(ticker, name, supply, beneficiary_txid_hex, beneficiary_vout, timestamp_secs) {
    const ptr0 = passStringToWasm0(ticker, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(beneficiary_txid_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.issueNiaContract(ptr0, len0, ptr1, len1, supply, ptr2, len2, beneficiary_vout, timestamp_secs);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return NiaIssuance.__wrap(ret[0]);
}

/**
 * Decode a NIA genesis consignment and extract the metadata fields a
 * receiver needs to register the contract in their rgbStash without
 * trusting the sender. Re-validates the consignment internally, so any
 * caller can pass arbitrary bytes from the wire without a prior check.
 *
 * Returns `{contractId, ticker, name, supply}`. The `supply` value comes
 * back as a decimal string (u64 outside JS Number's safe-integer range
 * would silently truncate otherwise).
 * @param {string} consignment_hex
 * @returns {NiaGenesisMetadata}
 */
export function niaGenesisMetadata(consignment_hex) {
    const ptr0 = passStringToWasm0(consignment_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.niaGenesisMetadata(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return NiaGenesisMetadata.__wrap(ret[0]);
}

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
 * @param {string} transition_hex
 * @returns {string[]}
 */
export function niaTransitionOutputs(transition_hex) {
    const ptr0 = passStringToWasm0(transition_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.niaTransitionOutputs(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

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
 * @param {string} consignment_hex
 * @returns {string}
 */
export function validateNiaConsignment(consignment_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(consignment_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.validateNiaConsignment(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

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
 * @param {string} transition_hex
 * @param {string} genesis_hex
 * @returns {string}
 */
export function validateNiaTransition(transition_hex, genesis_hex) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(transition_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(genesis_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.validateNiaTransition(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} transition_hex
 * @param {string} prev_transition_hex
 * @param {string} prev_genesis_hex
 * @returns {string}
 */
export function validateNiaTransitionFromPrev(transition_hex, prev_transition_hex, prev_genesis_hex) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(transition_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(prev_transition_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(prev_genesis_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.validateNiaTransitionFromPrev(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_string_get_d109740c0d18f4d7: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_3f44b700395062e5: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./rgb_spark_core_bg.js": import0,
    };
}

const NiaGenesisMetadataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_niagenesismetadata_free(ptr, 1));
const NiaIssuanceFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_niaissuance_free(ptr, 1));
const NiaTransitionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_niatransition_free(ptr, 1));
const SparkUtkProofJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sparkutkproofjs_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('rgb_spark_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
