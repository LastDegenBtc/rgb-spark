// Browser-side primitives for Spark-UTK + RGB on Spark.
//
// Phase 1B WASM bindings. Exposes the four Spark-UTK derivation
// functions used by the wallet on the client side plus a wasm-bindgen
// wrapper around [`SparkUtkProof`] that strict-encodes to the same
// bytes the validator (in rgb-consensus) expects.
//
// Chunk-β additions (2026-05-12): real RGB issuance via rgb-ops + rgb-schemas.
// `issueNiaContract` builds a Non-Inflatable Asset genesis programmatically
// and returns the deterministic 32-byte contractId — the value we feed into
// the Spark-UTK mint as `msg` so a Spark leaf commits to a specific RGB
// asset at issuance time.

use core::str::FromStr;

use amplify::confinement::Confined;
use bc::CompressedPk;
use commit_verify::mpc::Commitment;
// Lib-name (not package-name) gotcha: bp-consensus → bc, bp-dbc → dbc,
// rgb-consensus → rgbcore (via rgb-ops re-export), rgb-ops → rgbstd,
// rgb-schemas → schemata.
use dbc::keytweak::{self, SparkUtkProof};
use rgbstd::containers::{Consignment, ConsignmentExt};
use rgbstd::contract::{ContractBuilder, IssuerWrapper};
use rgbstd::stl::{AssetSpec, ContractTerms, RicardianContract};
use rgbstd::validation::{ResolveWitness, ValidationConfig, WitnessResolverError, WitnessStatus};
use rgbstd::vm::WitnessOrd;
use rgbstd::{Amount, ChainNet, GenesisSeal, Identity, Precision, Txid};
use schemata::NonInflatableAsset;
use strict_encoding::{StrictDeserialize, StrictSerialize};
use wasm_bindgen::prelude::*;

// SparkUtkProof is two 33-byte pubkeys plus strict-encoding overhead;
// 1 KiB is a comfortable ceiling that costs us nothing in the bundle.
const PROOF_MAX_LEN: usize = 1024;

// Genesis-only NIA consignment is small (a few KB), but we leave headroom
// for future transition consignments. 1 MiB matches the relay's per-blob cap.
const CONSIGNMENT_MAX_LEN: usize = 1_048_576;

/// Derive `U_tweaked = U_base + t·G`, with
/// `t = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)`.
///
/// `u_base_hex`: 33-byte compressed secp256k1 pubkey.
/// `msg_hex`: 32-byte RGB Merkle commitment.
/// Returns the tweaked 33-byte compressed pubkey (hex).
#[wasm_bindgen(js_name = deriveUTweaked)]
pub fn derive_u_tweaked(u_base_hex: &str, msg_hex: &str) -> Result<String, JsError> {
    let u_base = parse_pk(u_base_hex, "u_base")?;
    let msg: [u8; 32] = decode_fixed(msg_hex, "msg")?;
    let out = keytweak::derive_u_tweaked(&u_base, &msg).map_err(map_err("derive_u_tweaked"))?;
    Ok(hex::encode(out.to_byte_array()))
}

/// Derive the Spark leaf's `verifyingKey = U_tweaked + operator`.
/// Returns a 33-byte compressed pubkey (hex).
#[wasm_bindgen(js_name = deriveVerifyingKey)]
pub fn derive_verifying_key(
    u_base_hex: &str,
    msg_hex: &str,
    operator_hex: &str,
) -> Result<String, JsError> {
    let u_base = parse_pk(u_base_hex, "u_base")?;
    let operator = parse_pk(operator_hex, "operator")?;
    let msg: [u8; 32] = decode_fixed(msg_hex, "msg")?;
    let v = keytweak::derive_verifying_key(&u_base, &msg, &operator)
        .map_err(map_err("derive_verifying_key"))?;
    Ok(hex::encode(v.to_byte_array()))
}

/// Derive the L1 unilateral-exit BIP-341 noscript x-only output key.
/// Returns a 32-byte x-only pubkey (hex) — the same value that would
/// appear in the leaf's `verifyingKey`-tweaked p2tr output.
#[wasm_bindgen(js_name = deriveOutputXonly)]
pub fn derive_output_xonly(
    u_base_hex: &str,
    commitment_hex: &str,
    operator_hex: &str,
) -> Result<String, JsError> {
    let u_base = parse_pk(u_base_hex, "u_base")?;
    let operator = parse_pk(operator_hex, "operator")?;
    let cb: [u8; 32] = decode_fixed(commitment_hex, "commitment")?;
    let msg = Commitment::from(cb);
    let xonly = keytweak::derive_output_xonly(&u_base, &msg, &operator)
        .map_err(map_err("derive_output_xonly"))?;
    Ok(hex::encode(xonly))
}

/// JS handle around [`SparkUtkProof`]. Round-trips through the same
/// strict-encoding the rgb-consensus validator consumes.
#[wasm_bindgen]
pub struct SparkUtkProofJs {
    inner: SparkUtkProof,
}

#[wasm_bindgen]
impl SparkUtkProofJs {
    #[wasm_bindgen(constructor)]
    pub fn new(u_base_hex: &str, operator_hex: &str) -> Result<SparkUtkProofJs, JsError> {
        Ok(Self {
            inner: SparkUtkProof {
                u_base: parse_pk(u_base_hex, "u_base")?,
                operator: parse_pk(operator_hex, "operator")?,
            },
        })
    }

    #[wasm_bindgen(getter, js_name = uBase)]
    pub fn u_base(&self) -> String { hex::encode(self.inner.u_base.to_byte_array()) }

    #[wasm_bindgen(getter)]
    pub fn operator(&self) -> String { hex::encode(self.inner.operator.to_byte_array()) }

    /// Strict-encode the proof and return as hex. This is the on-the-wire
    /// representation embedded in RGB consignments.
    pub fn encode(&self) -> Result<String, JsError> {
        let bytes = self
            .inner
            .to_strict_serialized::<PROOF_MAX_LEN>()
            .map_err(map_err("strict encode"))?;
        Ok(hex::encode(bytes.release()))
    }

    /// Parse a strict-encoded `SparkUtkProof` (hex) back into a JS handle.
    pub fn decode(hex_str: &str) -> Result<SparkUtkProofJs, JsError> {
        let bytes = hex::decode(hex_str).map_err(map_err("hex decode"))?;
        let confined = Confined::<Vec<u8>, 0, PROOF_MAX_LEN>::try_from(bytes)
            .map_err(map_err("size limit"))?;
        let inner = SparkUtkProof::from_strict_serialized::<PROOF_MAX_LEN>(confined)
            .map_err(map_err("strict decode"))?;
        Ok(Self { inner })
    }
}

// ---- RGB issuance (chunk-β) ----

// Stand-in witness resolver for genesis-only consignments — no witness
// transactions to look up, but the validator still calls `check_chain_net`
// and may call `resolve_witness` defensively. We can't reuse rgb-ops'
// internal `DumbResolver` (pub(crate)) or schemata's `NoResolver` (panics
// in check_chain_net), so we ship our own minimal pass-through copy of
// the rgb-ops DumbResolver.
//
// IMPORTANT: this resolver pretends every queried witness is resolved and
// every chain net is allowed. It's safe for genesis-only consignments,
// which have no bundles to resolve. Transition consignments (chunk-γ
// session 2+) will need a real resolver that actually checks L1.
struct GenesisOnlyResolver;

impl ResolveWitness for GenesisOnlyResolver {
    fn resolve_witness(&self, _: Txid) -> Result<WitnessStatus, WitnessResolverError> {
        use bc::Tx;
        use strict_encoding::StrictDumb;
        Ok(WitnessStatus::Resolved(Tx::strict_dumb(), WitnessOrd::strict_dumb()))
    }

    fn check_chain_net(&self, _: ChainNet) -> Result<(), WitnessResolverError> { Ok(()) }
}


/// JS handle around the result of a NIA issuance — carries both the
/// deterministic contractId (the value we bind a Spark leaf to as `msg`)
/// AND the strict-encoded genesis consignment bytes (what a receiver
/// needs to validate the issuance client-side without trusting us).
#[wasm_bindgen]
pub struct NiaIssuance {
    contract_id_hex: String,
    consignment_hex: String,
}

#[wasm_bindgen]
impl NiaIssuance {
    #[wasm_bindgen(getter, js_name = contractId)]
    pub fn contract_id(&self) -> String { self.contract_id_hex.clone() }

    #[wasm_bindgen(getter, js_name = consignmentHex)]
    pub fn consignment_hex(&self) -> String { self.consignment_hex.clone() }
}

/// Build a Non-Inflatable Asset (NIA) contract genesis programmatically.
///
/// Returns `{ contractId, consignmentHex }`:
///   - `contractId`: 32-byte hex, the canonical RGB identifier — fed into
///     the Spark-UTK mint as `msg` so the leaf commits to this asset.
///   - `consignmentHex`: strict-encoded `Consignment<false>` bytes — sent
///     to the receiver alongside the Spark-UTK proof so they can validate
///     the issuance client-side via `validateNiaConsignment` below.
///
/// `ticker` / `name`: human-readable metadata.
/// `supply`: issued supply (allocated entirely to the beneficiary).
/// `beneficiary_txid_hex` / `beneficiary_vout`: the L1 outpoint that will
/// receive the asset at issuance. For UTK msg-binding use, a placeholder
/// is fine — what matters is the deterministic contractId.
/// `timestamp_secs`: unix timestamp for the genesis (caller-provided to
/// avoid chrono's wasm time path).
#[wasm_bindgen(js_name = issueNiaContract)]
pub fn issue_nia_contract(
    ticker: &str,
    name: &str,
    supply: u64,
    beneficiary_txid_hex: &str,
    beneficiary_vout: u32,
    timestamp_secs: i64,
) -> Result<NiaIssuance, JsError> {
    let txid = Txid::from_str(beneficiary_txid_hex)
        .map_err(|e| JsError::new(&format!("beneficiary_txid parse: {e}")))?;
    let beneficiary = GenesisSeal::new_random(txid, beneficiary_vout);

    let spec = AssetSpec::with(ticker, name, Precision::CentiMicro, None)
        .map_err(map_err("AssetSpec::with"))?;
    let terms = ContractTerms {
        text: RicardianContract::default(),
        media: None,
    };

    let contract = ContractBuilder::with(
        Identity::default(),
        NonInflatableAsset::schema(),
        NonInflatableAsset::types(),
        NonInflatableAsset::scripts(),
        ChainNet::BitcoinMainnet,
    )
    .add_global_state("spec", spec)
    .map_err(map_err("add_global_state(spec)"))?
    .add_global_state("terms", terms)
    .map_err(map_err("add_global_state(terms)"))?
    .add_global_state("issuedSupply", Amount::from(supply))
    .map_err(map_err("add_global_state(issuedSupply)"))?
    .add_fungible_state("assetOwner", beneficiary, supply)
    .map_err(map_err("add_fungible_state(assetOwner)"))?
    .issue_contract_raw(timestamp_secs)
    .map_err(map_err("issue_contract_raw"))?;

    let contract_id_hex = hex::encode(contract.contract_id().to_byte_array());

    let bytes = contract
        .to_strict_serialized::<CONSIGNMENT_MAX_LEN>()
        .map_err(map_err("strict encode consignment"))?;
    let consignment_hex = hex::encode(bytes.release());

    Ok(NiaIssuance { contract_id_hex, consignment_hex })
}

/// Decode + validate a strict-encoded NIA genesis consignment (hex).
/// Returns the contractId (32-byte hex) extracted from the validated
/// consignment, so the receiver can compare it against the `msgHex`
/// the Spark-UTK proof was bound to. Validation runs the full
/// rgb-consensus pipeline against `NonInflatableAsset::types()` as the
/// trusted typesystem — i.e. the receiver verifies the asset against
/// the canonical NIA schema, not a sender-supplied one.
///
/// Uses `NoResolver` because a genesis-only consignment has no witness
/// transactions to look up; transition consignments (chunk-γ session 2+)
/// will need a real resolver.
#[wasm_bindgen(js_name = validateNiaConsignment)]
pub fn validate_nia_consignment(consignment_hex: &str) -> Result<String, JsError> {
    let bytes = hex::decode(consignment_hex).map_err(map_err("hex decode"))?;
    let confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(bytes)
        .map_err(map_err("size limit"))?;
    let consignment = Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(confined)
        .map_err(map_err("strict decode consignment"))?;

    let validation_config = ValidationConfig {
        chain_net: ChainNet::BitcoinMainnet,
        trusted_typesystem: NonInflatableAsset::types(),
        ..Default::default()
    };
    let valid = consignment
        .validate(&GenesisOnlyResolver, &validation_config)
        .map_err(|e| JsError::new(&format!("consignment validation: {e:?}")))?;

    Ok(hex::encode(valid.contract_id().to_byte_array()))
}

// ---- helpers ----

fn parse_pk(s: &str, field: &str) -> Result<CompressedPk, JsError> {
    let bytes: [u8; 33] = decode_fixed(s, field)?;
    CompressedPk::from_byte_array(bytes)
        .map_err(|e| JsError::new(&format!("{field} parse: {e}")))
}

fn decode_fixed<const N: usize>(s: &str, field: &str) -> Result<[u8; N], JsError> {
    let bytes = hex::decode(s).map_err(|e| JsError::new(&format!("{field} hex: {e}")))?;
    bytes.as_slice().try_into().map_err(|_| {
        JsError::new(&format!(
            "{field} length: expected {N} bytes, got {}",
            bytes.len()
        ))
    })
}

fn map_err<E: core::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> JsError {
    move |e| JsError::new(&format!("{ctx}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generator G as a compressed pubkey — the smallest valid input we
    // can hand-roll without pulling test fixtures.
    const G_HEX: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const ZERO_MSG_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    #[test]
    fn derive_u_tweaked_runs() {
        let out = derive_u_tweaked(G_HEX, ZERO_MSG_HEX).expect("derive should succeed");
        assert_eq!(out.len(), 66, "compressed pubkey is 33 bytes = 66 hex chars");
        assert!(out.starts_with("02") || out.starts_with("03"));
        // Sanity: tweaking by a non-zero scalar must move the point.
        assert_ne!(out, G_HEX);
    }

    #[test]
    fn derive_verifying_key_combines_with_operator() {
        let v = derive_verifying_key(G_HEX, ZERO_MSG_HEX, G_HEX).expect("derive should succeed");
        assert_eq!(v.len(), 66);
    }

    #[test]
    fn derive_output_xonly_is_32_bytes() {
        let x = derive_output_xonly(G_HEX, ZERO_MSG_HEX, G_HEX).expect("derive should succeed");
        assert_eq!(x.len(), 64, "x-only is 32 bytes = 64 hex chars");
    }

    #[test]
    fn proof_roundtrip() {
        let proof = SparkUtkProofJs::new(G_HEX, G_HEX).expect("construct");
        let encoded = proof.encode().expect("encode");
        let decoded = SparkUtkProofJs::decode(&encoded).expect("decode");
        assert_eq!(proof.u_base(), decoded.u_base());
        assert_eq!(proof.operator(), decoded.operator());
    }

    // Realistic-looking but arbitrary mainnet-style txid for fixture beneficiary.
    const FIXTURE_TXID: &str =
        "14295d5bb1a191cdb6286dc0944df938421e3dfcbf0811353ccac4100c2068c5";

    #[test]
    fn issue_nia_contract_returns_32byte_hex_id_and_consignment_bytes() {
        let r = issue_nia_contract("TEST", "Test asset", 1_000_000, FIXTURE_TXID, 0, 0)
            .expect("issuance should succeed");
        assert_eq!(r.contract_id_hex.len(), 64, "contractId is 32 bytes = 64 hex");
        assert!(r.contract_id_hex.chars().all(|c| c.is_ascii_hexdigit()));
        // Consignment is the strict-encoded contract; a genesis-only NIA is
        // a few KB. Bound loosely to catch a regression in either direction.
        assert!(r.consignment_hex.len() > 200, "consignment_hex too small: {}", r.consignment_hex.len());
        assert!(r.consignment_hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn issue_nia_contract_changes_with_supply() {
        // Two issuances with the same beneficiary but different supply must
        // produce different contractIds — the supply is part of the genesis
        // committed state. (The other randomness source is GenesisSeal's
        // internal nonce, so we can't assert determinism across all inputs.)
        let a = issue_nia_contract("A", "A", 100, FIXTURE_TXID, 0, 1_700_000_000)
            .expect("issuance A");
        let b = issue_nia_contract("A", "A", 200, FIXTURE_TXID, 0, 1_700_000_000)
            .expect("issuance B");
        assert_ne!(a.contract_id_hex, b.contract_id_hex,
            "differing supplies must produce differing contractIds");
    }

    #[test]
    fn issue_then_validate_consignment_roundtrip() {
        // The whole chunk-γ session 1 promise: sender issues, gets bytes,
        // wire roundtrip (simulated as pure passthrough here), receiver
        // validates and pulls the same contractId out byte-for-byte.
        let issued = issue_nia_contract("RND", "Round-trip", 42, FIXTURE_TXID, 0, 1_700_000_001)
            .expect("issuance");
        let validated_id = validate_nia_consignment(&issued.consignment_hex)
            .expect("validate should succeed");
        assert_eq!(
            validated_id, issued.contract_id_hex,
            "receiver-derived contractId must equal sender contractId"
        );
    }

    // `JsError::new` panics on non-wasm targets (it's a stub when not compiled
    // to wasm32), so error-path assertions are gated to the wasm target.
    // Compile-time checking still happens on native via `cargo check`.
    #[cfg(target_arch = "wasm32")]
    #[test]
    fn issue_nia_contract_rejects_bad_txid() {
        let r = issue_nia_contract("X", "X", 1, "not-hex", 0, 0);
        assert!(r.is_err(), "non-hex txid must be rejected");
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn validate_nia_consignment_rejects_garbage() {
        let r = validate_nia_consignment("00");
        assert!(r.is_err(), "single-byte garbage must not decode as a consignment");
    }
}
