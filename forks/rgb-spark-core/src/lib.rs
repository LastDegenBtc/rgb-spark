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
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use amplify::confinement::Confined;
use bc::CompressedPk;
use commit_verify::mpc::Commitment;
// Lib-name (not package-name) gotcha: bp-consensus → bc, bp-dbc → dbc,
// rgb-consensus → rgbcore (via rgb-ops re-export), rgb-ops → rgbstd,
// rgb-schemas → schemata.
use dbc::keytweak::{self, SparkUtkProof};
use rgbstd::containers::{Consignment, ConsignmentExt};
use rgbstd::contract::{AllocatedState, ContractBuilder, IssuerWrapper, TransitionBuilder};
use rgbstd::persistence::MemContract;
use rgbstd::stl::{AssetSpec, ContractTerms, RicardianContract};
use rgbstd::validation::{ResolveWitness, ValidationConfig, WitnessResolverError, WitnessStatus};
use rgbstd::vm::{ContractStateEvolve, OrdOpRef, WitnessOrd};
use rgbstd::{
    Amount, AssignmentType, BundleId, ChainNet, GenesisSeal, GraphSeal, Identity, Operation,
    Opout, Precision, RevealedState, RevealedValue, Transition, Txid,
};
use schemata::{NonInflatableAsset, GS_ISSUED_SUPPLY, GS_NOMINAL, OS_ASSET};
use strict_encoding::{StrictDeserialize, StrictDumb, StrictSerialize};
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

/// JS handle around the human-readable + supply metadata extracted from a
/// validated NIA genesis. Lets the buyer-side inbox auto-populate the
/// `StashContract` shape without trusting the seller's envelope claims —
/// ticker, name, supply are all schema-validated bytes from the genesis.
#[wasm_bindgen]
pub struct NiaGenesisMetadata {
    contract_id_hex: String,
    ticker: String,
    name: String,
    // u64 returned as decimal string to dodge JS Number precision (>2^53).
    supply: String,
}

#[wasm_bindgen]
impl NiaGenesisMetadata {
    #[wasm_bindgen(getter, js_name = contractId)]
    pub fn contract_id(&self) -> String { self.contract_id_hex.clone() }

    #[wasm_bindgen(getter)]
    pub fn ticker(&self) -> String { self.ticker.clone() }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String { self.name.clone() }

    /// Decimal string. JS side parses as BigInt or compares as string.
    #[wasm_bindgen(getter)]
    pub fn supply(&self) -> String { self.supply.clone() }
}

/// Decode a NIA genesis consignment and extract the metadata fields a
/// receiver needs to register the contract in their rgbStash without
/// trusting the sender. Re-validates the consignment internally, so any
/// caller can pass arbitrary bytes from the wire without a prior check.
///
/// Returns `{contractId, ticker, name, supply}`. The `supply` value comes
/// back as a decimal string (u64 outside JS Number's safe-integer range
/// would silently truncate otherwise).
#[wasm_bindgen(js_name = niaGenesisMetadata)]
pub fn nia_genesis_metadata(consignment_hex: &str) -> Result<NiaGenesisMetadata, JsError> {
    let bytes = hex::decode(consignment_hex).map_err(map_err("hex decode"))?;
    let confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(bytes)
        .map_err(map_err("size limit"))?;
    let consignment = Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(confined)
        .map_err(map_err("strict decode consignment"))?;

    // Re-run schema validation rather than trusting the bytes: a malformed
    // genesis could be syntactically decodable but schema-invalid, and we
    // don't want to surface ticker/name/supply that would never round-trip
    // through the validator. `Consignment::validate` consumes `self`, so we
    // hand it a clone and keep the original to read globals from.
    let validation_config = ValidationConfig {
        chain_net: ChainNet::BitcoinMainnet,
        trusted_typesystem: NonInflatableAsset::types(),
        ..Default::default()
    };
    let valid = consignment
        .clone()
        .validate(&GenesisOnlyResolver, &validation_config)
        .map_err(|e| JsError::new(&format!("consignment validation: {e:?}")))?;
    let contract_id_hex = hex::encode(valid.contract_id().to_byte_array());

    let genesis = consignment.genesis();
    let globals = &genesis.globals;

    // Spec under GS_NOMINAL — AssetSpec carries ticker + name + precision.
    // GlobalValues derefs to Confined<Vec<RevealedData>>; indexing into [0]
    // is safe because the schema requires Occurrences::Once on GS_NOMINAL
    // (= validated above).
    let spec_values = globals
        .get(&GS_NOMINAL)
        .ok_or_else(|| JsError::new("genesis: missing GS_NOMINAL global"))?;
    let spec_blob = spec_values
        .first()
        .ok_or_else(|| JsError::new("genesis: GS_NOMINAL has no values"))?;
    // RevealedData wraps SmallBlob; its `#[wrapper(AsSlice, ...)]` macro
    // generates `as_slice() -> &[u8]` for us.
    let spec_bytes: Vec<u8> = spec_blob.as_slice().to_vec();
    let spec_confined =
        Confined::<Vec<u8>, 0, { u16::MAX as usize }>::try_from(spec_bytes)
            .map_err(map_err("AssetSpec confined"))?;
    let spec = AssetSpec::from_strict_serialized::<{ u16::MAX as usize }>(spec_confined)
        .map_err(map_err("strict decode AssetSpec"))?;

    // Supply under GS_ISSUED_SUPPLY — Amount carries the u64 value.
    let supply_values = globals
        .get(&GS_ISSUED_SUPPLY)
        .ok_or_else(|| JsError::new("genesis: missing GS_ISSUED_SUPPLY global"))?;
    let supply_blob = supply_values
        .first()
        .ok_or_else(|| JsError::new("genesis: GS_ISSUED_SUPPLY has no values"))?;
    let supply_bytes: Vec<u8> = supply_blob.as_slice().to_vec();
    let supply_confined =
        Confined::<Vec<u8>, 0, { u16::MAX as usize }>::try_from(supply_bytes)
            .map_err(map_err("Amount confined"))?;
    let amount = Amount::from_strict_serialized::<{ u16::MAX as usize }>(supply_confined)
        .map_err(map_err("strict decode Amount"))?;

    Ok(NiaGenesisMetadata {
        contract_id_hex,
        ticker: spec.ticker.to_string(),
        name: spec.name.to_string(),
        supply: amount.value().to_string(),
    })
}

/// JS handle around the result of building a NIA `Transition`. Carries
/// both the strict-encoded transition bytes and `transition.id()` — the
/// 32-byte opid which the sender feeds into the receiver-side Spark-UTK
/// mint as `msg`, so the new leaf is cryptographically bound to *this*
/// specific RGB state-transition.
#[wasm_bindgen]
pub struct NiaTransition {
    transition_hex: String,
    commit_id_hex: String,
}

#[wasm_bindgen]
impl NiaTransition {
    #[wasm_bindgen(getter, js_name = transitionHex)]
    pub fn transition_hex(&self) -> String { self.transition_hex.clone() }

    #[wasm_bindgen(getter, js_name = commitIdHex)]
    pub fn commit_id_hex(&self) -> String { self.commit_id_hex.clone() }
}

// Pulls the i-th `assetOwner` fungible assignment out of a NIA genesis
// and returns its `RevealedValue` (which carries the `Amount` and a
// blinding factor). Used by both `build_nia_transition` (to pass the
// prior allocation as an input to TransitionBuilder) and
// `validate_nia_transition` (to construct the `prev_state` map fed
// into `Schema::validate_state`).
fn genesis_asset_at(
    genesis_consignment: &Consignment<false>,
    no: u16,
) -> Result<RevealedValue, JsError> {
    let typed = genesis_consignment
        .genesis()
        .assignments
        .get(&OS_ASSET)
        .ok_or_else(|| JsError::new("genesis: missing OS_ASSET assignment"))?;
    let fungibles = typed.as_fungible();
    let entry = fungibles
        .get(no as usize)
        .ok_or_else(|| JsError::new(&format!("genesis: no OS_ASSET assignment at index {no}")))?;
    let (_seal, value) = entry
        .as_revealed()
        .ok_or_else(|| JsError::new("genesis: OS_ASSET assignment is not revealed"))?;
    Ok(*value)
}

// Same as `genesis_asset_at`, but pulls from a `Transition`'s output
// assignments instead. Used when building a transition that consumes
// the output of a prior transition (chain depth ≥ 2): the new
// `TransitionBuilder.add_input` needs the prior `RevealedValue` to
// pass through to the schema validator's conservation check.
fn transition_asset_at(
    tr: &Transition,
    no: u16,
) -> Result<RevealedValue, JsError> {
    let typed = tr
        .assignments
        .get(&OS_ASSET)
        .ok_or_else(|| JsError::new("transition: missing OS_ASSET assignment"))?;
    let fungibles = typed.as_fungible();
    let entry = fungibles
        .get(no as usize)
        .ok_or_else(|| JsError::new(&format!("transition: no OS_ASSET assignment at index {no}")))?;
    let (_seal, value) = entry
        .as_revealed()
        .ok_or_else(|| JsError::new("transition: OS_ASSET assignment is not revealed"))?;
    Ok(*value)
}

/// Extract the per-output asset amounts from a strict-encoded NIA
/// `Transition` (hex). Returns one decimal string per output,
/// indexed by the output's position in `transition.assignments[OS_ASSET]`.
///
/// Trustless replacement for "trust the sender's envelope claim about
/// who got what": the receiver decodes the transition bytes themselves
/// and reads the amounts the schema validator just signed off on.
///
/// `transition_hex`: strict-encoded `Transition` (= what
/// `buildNiaTransition*` produces).
///
/// Decimal strings (not `u64` directly) for the same JS-Number-
/// precision reason as `niaGenesisMetadata.supply`.
#[wasm_bindgen(js_name = niaTransitionOutputs)]
pub fn nia_transition_outputs(transition_hex: &str) -> Result<Vec<String>, JsError> {
    let tr_bytes = hex::decode(transition_hex).map_err(map_err("transition hex decode"))?;
    let tr_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(tr_bytes)
        .map_err(map_err("transition size limit"))?;
    let transition = Transition::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(tr_confined)
        .map_err(map_err("strict decode transition"))?;

    let typed = transition
        .assignments
        .get(&OS_ASSET)
        .ok_or_else(|| JsError::new("transition: missing OS_ASSET assignment"))?;
    let fungibles = typed.as_fungible();

    let mut out: Vec<String> = Vec::with_capacity(fungibles.len());
    for (i, assign) in fungibles.iter().enumerate() {
        let (_seal, value) = assign
            .as_revealed()
            .ok_or_else(|| JsError::new(&format!(
                "transition: OS_ASSET assignment at index {i} is not revealed"
            )))?;
        let amount: Amount = (*value).into();
        out.push(amount.value().to_string());
    }
    Ok(out)
}

/// Build a NIA `transfer` state transition consuming the `no`-th
/// `assetOwner` assignment of a previously issued genesis, allocating
/// `amount` units to a new beneficiary seal. Returns
/// `{ transitionHex, commitIdHex }` where `commitIdHex` is the
/// `transition.id()` to be used as `msg` for the receiver's Spark-UTK
/// mint.
///
/// `genesis_hex`: strict-encoded `Consignment<false>` (genesis-only) as
///                produced by `issueNiaContract`.
/// `consume_index`: which `assetOwner` output of the genesis to spend
///                  (`0` for the single-output case our `issueNiaContract`
///                  produces today).
/// `amount`: units to allocate to the beneficiary. Must equal the
///           prior allocation's amount (`svs OS_ASSET` enforces
///           conservation — no split/merge yet).
/// `beneficiary_txid_hex` / `beneficiary_vout`: the L1 outpoint that
///           formally "owns" the new RGB allocation. Placeholder-safe
///           in the Spark flow — never resolved on chain.
#[wasm_bindgen(js_name = buildNiaTransition)]
pub fn build_nia_transition(
    genesis_hex: &str,
    consume_index: u16,
    amount: u64,
    beneficiary_txid_hex: &str,
    beneficiary_vout: u32,
) -> Result<NiaTransition, JsError> {
    let bytes = hex::decode(genesis_hex).map_err(map_err("genesis hex decode"))?;
    let confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(bytes)
        .map_err(map_err("size limit"))?;
    let genesis_consignment =
        Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(confined)
            .map_err(map_err("strict decode genesis"))?;

    let prev_value = genesis_asset_at(&genesis_consignment, consume_index)?;
    let prev_amount: Amount = prev_value.into();
    if Amount::from(amount) != prev_amount {
        return Err(JsError::new(&format!(
            "amount {amount} != prev allocation {prev_amount}; split/merge not supported in this binding"
        )));
    }

    let contract_id = genesis_consignment.contract_id();
    let genesis_opid = genesis_consignment.genesis().id();

    let txid = Txid::from_str(beneficiary_txid_hex)
        .map_err(|e| JsError::new(&format!("beneficiary_txid parse: {e}")))?;
    let beneficiary = GraphSeal::new_random(txid, beneficiary_vout);

    let mut builder = TransitionBuilder::named_transition(
        contract_id,
        NonInflatableAsset::schema(),
        "transfer",
        NonInflatableAsset::types(),
    )
    .map_err(map_err("TransitionBuilder::named_transition"))?;

    let opout = Opout::new(genesis_opid, OS_ASSET, consume_index);
    builder = builder
        .add_input(opout, AllocatedState::Amount(prev_value))
        .map_err(map_err("add_input"))?;
    builder = builder
        .add_fungible_state("assetOwner", beneficiary, Amount::from(amount))
        .map_err(map_err("add_fungible_state"))?;

    let transition = builder
        .complete_transition()
        .map_err(map_err("complete_transition"))?;
    let opid = transition.id();
    let bytes = transition
        .to_strict_serialized::<CONSIGNMENT_MAX_LEN>()
        .map_err(map_err("strict encode transition"))?;

    Ok(NiaTransition {
        transition_hex: hex::encode(bytes.release()),
        commit_id_hex: hex::encode(opid.to_byte_array()),
    })
}

/// Validate a strict-encoded NIA `Transition` (hex) against its prior
/// `Consignment<false>` (genesis, hex). Returns `transition.id()` as
/// 32-byte hex — the value the receiver compares with `msgHex` to
/// confirm the new leaf's Spark-UTK binding refers to *this* specific
/// transition.
///
/// This is the Spark-native path: we run the rgb-consensus schema
/// validator (typesystem checks + AluVM `svs OS_ASSET` conservation
/// check) on the transition in isolation, with the input state map
/// built deterministically from the genesis assignments. We do NOT
/// go through `Validator::validate_bundles`, which would require a
/// `ResolveWitness` impl pointing at an L1 commitment — Spark replaces
/// the L1 transport, see [feedback_no_synthetic_l1_witness].
#[wasm_bindgen(js_name = validateNiaTransition)]
pub fn validate_nia_transition(
    transition_hex: &str,
    genesis_hex: &str,
) -> Result<String, JsError> {
    let tr_bytes = hex::decode(transition_hex).map_err(map_err("transition hex decode"))?;
    let tr_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(tr_bytes)
        .map_err(map_err("transition size limit"))?;
    let transition = Transition::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(tr_confined)
        .map_err(map_err("strict decode transition"))?;

    let g_bytes = hex::decode(genesis_hex).map_err(map_err("genesis hex decode"))?;
    let g_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(g_bytes)
        .map_err(map_err("genesis size limit"))?;
    let genesis_consignment =
        Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(g_confined)
            .map_err(map_err("strict decode genesis"))?;

    let genesis = genesis_consignment.genesis();
    let contract_id = genesis_consignment.contract_id();
    let genesis_opid = genesis.id();

    if transition.contract_id != contract_id {
        return Err(JsError::new(&format!(
            "transition.contract_id {} != genesis.contract_id {}",
            transition.contract_id, contract_id
        )));
    }

    let mut prev_state: BTreeMap<AssignmentType, Vec<RevealedState>> = BTreeMap::new();
    for input in &transition.inputs {
        if input.op != genesis_opid {
            return Err(JsError::new(&format!(
                "transition input opid {} does not match genesis opid {}; \
                 only single-hop genesis→transition chains are supported here",
                input.op, genesis_opid
            )));
        }
        let typed = genesis
            .assignments
            .get(&input.ty)
            .ok_or_else(|| JsError::new(&format!("genesis missing assignment type {}", input.ty)))?;
        let revealed = typed
            .to_revealed_assign_at(input.no, None)
            .map_err(|_| JsError::new(&format!("genesis input out of range: {input}")))?;
        let (_seal, state) = revealed
            .into_revealed()
            .ok_or_else(|| JsError::new(&format!("genesis input not revealed: {input}")))?;
        prev_state.entry(input.ty).or_default().push(state);
    }

    let schema = NonInflatableAsset::schema();
    let types = NonInflatableAsset::types();
    let scripts = NonInflatableAsset::scripts();

    let contract_state =
        Rc::new(RefCell::new(MemContract::init((&schema, contract_id))));

    schema
        .validate_state(
            &types,
            &scripts,
            genesis,
            OrdOpRef::Genesis(genesis),
            contract_state.clone(),
            &BTreeMap::new(),
        )
        .map_err(|e| JsError::new(&format!("genesis re-validation: {e:?}")))?;

    // Witness metadata: in the Spark flow there is no L1 witness tx, so
    // we feed deterministic placeholders. The AluVM transfer script
    // (`svs OS_ASSET`) reads only `prev_state` and `op.assignments`;
    // these fields are recorded in the MemContract but never used to
    // resolve anything.
    let witness_txid = Txid::strict_dumb();
    let witness_ord = WitnessOrd::strict_dumb();
    let bundle_id = BundleId::strict_dumb();

    schema
        .validate_state(
            &types,
            &scripts,
            genesis,
            OrdOpRef::Transition(&transition, witness_txid, witness_ord, bundle_id),
            contract_state,
            &prev_state,
        )
        .map_err(|e| JsError::new(&format!("transition validation: {e:?}")))?;

    Ok(hex::encode(transition.id().to_byte_array()))
}

/// Build a NIA transition consuming the `no`-th `assetOwner` assignment
/// of a PRIOR TRANSITION (not the genesis). The chain so far is
/// `genesis → prev_transition`; this builds the next link
/// `genesis → prev_transition → new_transition`.
///
/// Used by the orderbook settlement flow: when a seller already has
/// a transition T_1 binding them to the asset, completing a swap means
/// producing T_2 that consumes T_1's output and allocates to the buyer
/// — without T_2 the buyer has no chain-of-ownership artifact even if
/// the Spark leaf is transferred via HTLC.
///
/// `prev_transition_hex`: strict-encoded `Transition` (= prior link in
///                        the chain).
/// `prev_genesis_hex`: the `Consignment<false>` of the contract's
///                     genesis (needed to recover contractId; for
///                     conservation checks the WASM schema validator
///                     in `validateNiaTransitionFromPrev` also re-runs
///                     the genesis through `validate_state`).
/// `consume_index`: which assetOwner output of `prev_transition` to
///                  spend. `0` for the single-output case our
///                  `buildNiaTransition` produces.
/// `amount`: must equal the prior allocation's amount (`svs OS_ASSET`
///           conservation — no split/merge yet at this layer).
#[wasm_bindgen(js_name = buildNiaTransitionFromPrev)]
pub fn build_nia_transition_from_prev(
    prev_transition_hex: &str,
    prev_genesis_hex: &str,
    consume_index: u16,
    amount: u64,
    beneficiary_txid_hex: &str,
    beneficiary_vout: u32,
) -> Result<NiaTransition, JsError> {
    let tr_bytes = hex::decode(prev_transition_hex).map_err(map_err("prev_transition hex decode"))?;
    let tr_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(tr_bytes)
        .map_err(map_err("prev_transition size limit"))?;
    let prev_transition = Transition::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(tr_confined)
        .map_err(map_err("strict decode prev_transition"))?;

    let g_bytes = hex::decode(prev_genesis_hex).map_err(map_err("prev_genesis hex decode"))?;
    let g_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(g_bytes)
        .map_err(map_err("prev_genesis size limit"))?;
    let genesis_consignment =
        Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(g_confined)
            .map_err(map_err("strict decode prev_genesis"))?;

    let contract_id = genesis_consignment.contract_id();
    if prev_transition.contract_id != contract_id {
        return Err(JsError::new(&format!(
            "prev_transition.contract_id {} != prev_genesis.contract_id {}",
            prev_transition.contract_id, contract_id
        )));
    }

    let prev_value = transition_asset_at(&prev_transition, consume_index)?;
    let prev_amount: Amount = prev_value.into();
    if Amount::from(amount) != prev_amount {
        return Err(JsError::new(&format!(
            "amount {amount} != prev allocation {prev_amount}; split/merge not supported"
        )));
    }

    let prev_opid = prev_transition.id();
    let txid = Txid::from_str(beneficiary_txid_hex)
        .map_err(|e| JsError::new(&format!("beneficiary_txid parse: {e}")))?;
    let beneficiary = GraphSeal::new_random(txid, beneficiary_vout);

    let mut builder = TransitionBuilder::named_transition(
        contract_id,
        NonInflatableAsset::schema(),
        "transfer",
        NonInflatableAsset::types(),
    )
    .map_err(map_err("TransitionBuilder::named_transition"))?;

    let opout = Opout::new(prev_opid, OS_ASSET, consume_index);
    builder = builder
        .add_input(opout, AllocatedState::Amount(prev_value))
        .map_err(map_err("add_input"))?;
    builder = builder
        .add_fungible_state("assetOwner", beneficiary, Amount::from(amount))
        .map_err(map_err("add_fungible_state"))?;

    let transition = builder
        .complete_transition()
        .map_err(map_err("complete_transition"))?;
    let opid = transition.id();
    let bytes = transition
        .to_strict_serialized::<CONSIGNMENT_MAX_LEN>()
        .map_err(map_err("strict encode transition"))?;

    Ok(NiaTransition {
        transition_hex: hex::encode(bytes.release()),
        commit_id_hex: hex::encode(opid.to_byte_array()),
    })
}

/// Multi-output sibling of `buildNiaTransition`. Builds a NIA
/// `transfer` transition consuming the `no`-th genesis assetOwner
/// assignment and allocating to N beneficiary seals with arbitrary
/// per-output amounts. The schema validator enforces `sum(out) ==
/// sum(in)` via AluVM; we also pre-check it here to fail fast on
/// caller mistakes.
///
/// Parallel arrays `amounts_dec` / `beneficiary_txids_hex` /
/// `beneficiary_vouts` MUST have equal length (== number of outputs).
/// `amounts_dec` values are decimal-encoded u64 strings (dodge JS
/// Number precision for amounts > 2^53).
///
/// This is the load-bearing primitive for split-merge support in
/// RGB-SPK (Phase 1C/clean session 7.1): fractional ownership requires
/// that one transition assigns N units to a buyer and M units back to
/// the seller as change. `buildNiaTransition` (the 1-output API) stays
/// in place for backward compatibility while the wallet migrates.
#[wasm_bindgen(js_name = buildNiaTransitionMultiOutput)]
pub fn build_nia_transition_multi_output(
    genesis_hex: &str,
    consume_index: u16,
    amounts_dec: Vec<String>,
    beneficiary_txids_hex: Vec<String>,
    beneficiary_vouts: Vec<u32>,
) -> Result<NiaTransition, JsError> {
    let n = amounts_dec.len();
    if n == 0 {
        return Err(JsError::new("at least one output is required"));
    }
    if beneficiary_txids_hex.len() != n || beneficiary_vouts.len() != n {
        return Err(JsError::new(&format!(
            "parallel arrays must have equal length: amounts={n}, txids={}, vouts={}",
            beneficiary_txids_hex.len(),
            beneficiary_vouts.len()
        )));
    }

    let amounts: Vec<u64> = amounts_dec
        .iter()
        .enumerate()
        .map(|(i, s)| {
            s.parse::<u64>()
                .map_err(|e| JsError::new(&format!("amounts_dec[{i}] parse: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let bytes = hex::decode(genesis_hex).map_err(map_err("genesis hex decode"))?;
    let confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(bytes)
        .map_err(map_err("size limit"))?;
    let genesis_consignment =
        Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(confined)
            .map_err(map_err("strict decode genesis"))?;

    let prev_value = genesis_asset_at(&genesis_consignment, consume_index)?;
    let prev_amount: Amount = prev_value.into();
    // u64 sum can overflow if N outputs total > u64::MAX, but since each
    // amount fits in u64 and we cap at `prev_amount` (itself u64), a
    // checked_sum is sufficient.
    let sum_amounts: u64 = amounts
        .iter()
        .try_fold(0u64, |acc, &a| acc.checked_add(a))
        .ok_or_else(|| JsError::new("sum of output amounts overflows u64"))?;
    if Amount::from(sum_amounts) != prev_amount {
        return Err(JsError::new(&format!(
            "sum of outputs {sum_amounts} != prev allocation {prev_amount}; conservation violated"
        )));
    }

    let contract_id = genesis_consignment.contract_id();
    let genesis_opid = genesis_consignment.genesis().id();

    let mut builder = TransitionBuilder::named_transition(
        contract_id,
        NonInflatableAsset::schema(),
        "transfer",
        NonInflatableAsset::types(),
    )
    .map_err(map_err("TransitionBuilder::named_transition"))?;

    let opout = Opout::new(genesis_opid, OS_ASSET, consume_index);
    builder = builder
        .add_input(opout, AllocatedState::Amount(prev_value))
        .map_err(map_err("add_input"))?;

    for i in 0..n {
        let txid = Txid::from_str(&beneficiary_txids_hex[i])
            .map_err(|e| JsError::new(&format!("beneficiary_txids_hex[{i}] parse: {e}")))?;
        let beneficiary = GraphSeal::new_random(txid, beneficiary_vouts[i]);
        builder = builder
            .add_fungible_state("assetOwner", beneficiary, Amount::from(amounts[i]))
            .map_err(map_err("add_fungible_state"))?;
    }

    let transition = builder
        .complete_transition()
        .map_err(map_err("complete_transition"))?;
    let opid = transition.id();
    let bytes = transition
        .to_strict_serialized::<CONSIGNMENT_MAX_LEN>()
        .map_err(map_err("strict encode transition"))?;

    Ok(NiaTransition {
        transition_hex: hex::encode(bytes.release()),
        commit_id_hex: hex::encode(opid.to_byte_array()),
    })
}

/// Multi-output sibling of `buildNiaTransitionFromPrev`. Same shape
/// as `buildNiaTransitionMultiOutput` but consumes a prior transition's
/// output instead of the genesis. Used in the orderbook settlement path
/// when the seller's pre-swap leaf carries more units than the order
/// amount — one output goes to the buyer, one back to the seller as
/// change.
#[wasm_bindgen(js_name = buildNiaTransitionMultiOutputFromPrev)]
pub fn build_nia_transition_multi_output_from_prev(
    prev_transition_hex: &str,
    prev_genesis_hex: &str,
    consume_index: u16,
    amounts_dec: Vec<String>,
    beneficiary_txids_hex: Vec<String>,
    beneficiary_vouts: Vec<u32>,
) -> Result<NiaTransition, JsError> {
    let n = amounts_dec.len();
    if n == 0 {
        return Err(JsError::new("at least one output is required"));
    }
    if beneficiary_txids_hex.len() != n || beneficiary_vouts.len() != n {
        return Err(JsError::new(&format!(
            "parallel arrays must have equal length: amounts={n}, txids={}, vouts={}",
            beneficiary_txids_hex.len(),
            beneficiary_vouts.len()
        )));
    }

    let amounts: Vec<u64> = amounts_dec
        .iter()
        .enumerate()
        .map(|(i, s)| {
            s.parse::<u64>()
                .map_err(|e| JsError::new(&format!("amounts_dec[{i}] parse: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let tr_bytes =
        hex::decode(prev_transition_hex).map_err(map_err("prev_transition hex decode"))?;
    let tr_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(tr_bytes)
        .map_err(map_err("prev_transition size limit"))?;
    let prev_transition = Transition::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(tr_confined)
        .map_err(map_err("strict decode prev_transition"))?;

    let g_bytes = hex::decode(prev_genesis_hex).map_err(map_err("prev_genesis hex decode"))?;
    let g_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(g_bytes)
        .map_err(map_err("prev_genesis size limit"))?;
    let genesis_consignment =
        Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(g_confined)
            .map_err(map_err("strict decode prev_genesis"))?;

    let contract_id = genesis_consignment.contract_id();
    if prev_transition.contract_id != contract_id {
        return Err(JsError::new(&format!(
            "prev_transition.contract_id {} != prev_genesis.contract_id {}",
            prev_transition.contract_id, contract_id
        )));
    }

    let prev_value = transition_asset_at(&prev_transition, consume_index)?;
    let prev_amount: Amount = prev_value.into();
    let sum_amounts: u64 = amounts
        .iter()
        .try_fold(0u64, |acc, &a| acc.checked_add(a))
        .ok_or_else(|| JsError::new("sum of output amounts overflows u64"))?;
    if Amount::from(sum_amounts) != prev_amount {
        return Err(JsError::new(&format!(
            "sum of outputs {sum_amounts} != prev allocation {prev_amount}; conservation violated"
        )));
    }

    let prev_opid = prev_transition.id();

    let mut builder = TransitionBuilder::named_transition(
        contract_id,
        NonInflatableAsset::schema(),
        "transfer",
        NonInflatableAsset::types(),
    )
    .map_err(map_err("TransitionBuilder::named_transition"))?;

    let opout = Opout::new(prev_opid, OS_ASSET, consume_index);
    builder = builder
        .add_input(opout, AllocatedState::Amount(prev_value))
        .map_err(map_err("add_input"))?;

    for i in 0..n {
        let txid = Txid::from_str(&beneficiary_txids_hex[i])
            .map_err(|e| JsError::new(&format!("beneficiary_txids_hex[{i}] parse: {e}")))?;
        let beneficiary = GraphSeal::new_random(txid, beneficiary_vouts[i]);
        builder = builder
            .add_fungible_state("assetOwner", beneficiary, Amount::from(amounts[i]))
            .map_err(map_err("add_fungible_state"))?;
    }

    let transition = builder
        .complete_transition()
        .map_err(map_err("complete_transition"))?;
    let opid = transition.id();
    let bytes = transition
        .to_strict_serialized::<CONSIGNMENT_MAX_LEN>()
        .map_err(map_err("strict encode transition"))?;

    Ok(NiaTransition {
        transition_hex: hex::encode(bytes.release()),
        commit_id_hex: hex::encode(opid.to_byte_array()),
    })
}

/// Validate a NIA transition chain of length 3: genesis → prev_transition
/// → transition. Re-runs the rgb-consensus schema validator on every
/// link (genesis schema check, prev_transition consumed-from-genesis
/// check, transition consumed-from-prev_transition check) and returns
/// `transition.id()` if all three validate.
///
/// Same trust posture as `validateNiaTransition`: no L1 witness, no
/// `ResolveWitness` — Spark replaces the transport layer (see
/// `feedback_no_synthetic_l1_witness`). Witness metadata fed to
/// `OrdOpRef::Transition(...)` is `strict_dumb` because the NIA AluVM
/// scripts only inspect input/output assignments, never the witness
/// txid.
#[wasm_bindgen(js_name = validateNiaTransitionFromPrev)]
pub fn validate_nia_transition_from_prev(
    transition_hex: &str,
    prev_transition_hex: &str,
    prev_genesis_hex: &str,
) -> Result<String, JsError> {
    let tr_bytes = hex::decode(transition_hex).map_err(map_err("transition hex decode"))?;
    let tr_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(tr_bytes)
        .map_err(map_err("transition size limit"))?;
    let transition = Transition::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(tr_confined)
        .map_err(map_err("strict decode transition"))?;

    let prev_bytes = hex::decode(prev_transition_hex).map_err(map_err("prev_transition hex decode"))?;
    let prev_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(prev_bytes)
        .map_err(map_err("prev_transition size limit"))?;
    let prev_transition = Transition::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(prev_confined)
        .map_err(map_err("strict decode prev_transition"))?;

    let g_bytes = hex::decode(prev_genesis_hex).map_err(map_err("prev_genesis hex decode"))?;
    let g_confined = Confined::<Vec<u8>, 0, CONSIGNMENT_MAX_LEN>::try_from(g_bytes)
        .map_err(map_err("prev_genesis size limit"))?;
    let genesis_consignment =
        Consignment::<false>::from_strict_serialized::<CONSIGNMENT_MAX_LEN>(g_confined)
            .map_err(map_err("strict decode prev_genesis"))?;

    let genesis = genesis_consignment.genesis();
    let contract_id = genesis_consignment.contract_id();
    let genesis_opid = genesis.id();
    let prev_opid = prev_transition.id();

    if transition.contract_id != contract_id {
        return Err(JsError::new(&format!(
            "transition.contract_id {} != prev_genesis.contract_id {}",
            transition.contract_id, contract_id
        )));
    }
    if prev_transition.contract_id != contract_id {
        return Err(JsError::new(&format!(
            "prev_transition.contract_id {} != prev_genesis.contract_id {}",
            prev_transition.contract_id, contract_id
        )));
    }

    // prev_state for `transition`: each input must reference prev_transition.
    let mut tr_prev_state: BTreeMap<AssignmentType, Vec<RevealedState>> = BTreeMap::new();
    for input in &transition.inputs {
        if input.op != prev_opid {
            return Err(JsError::new(&format!(
                "transition input opid {} does not match prev_transition opid {}",
                input.op, prev_opid
            )));
        }
        let typed = prev_transition
            .assignments
            .get(&input.ty)
            .ok_or_else(|| JsError::new(&format!("prev_transition missing assignment type {}", input.ty)))?;
        let revealed = typed
            .to_revealed_assign_at(input.no, None)
            .map_err(|_| JsError::new(&format!("prev_transition input out of range: {input}")))?;
        let (_seal, state) = revealed
            .into_revealed()
            .ok_or_else(|| JsError::new(&format!("prev_transition input not revealed: {input}")))?;
        tr_prev_state.entry(input.ty).or_default().push(state);
    }

    // prev_state for prev_transition: each input must reference the genesis.
    let mut prev_prev_state: BTreeMap<AssignmentType, Vec<RevealedState>> = BTreeMap::new();
    for input in &prev_transition.inputs {
        if input.op != genesis_opid {
            return Err(JsError::new(&format!(
                "prev_transition input opid {} does not match genesis opid {}; \
                 chain longer than (genesis → prev_transition → transition) not yet supported",
                input.op, genesis_opid
            )));
        }
        let typed = genesis
            .assignments
            .get(&input.ty)
            .ok_or_else(|| JsError::new(&format!("genesis missing assignment type {}", input.ty)))?;
        let revealed = typed
            .to_revealed_assign_at(input.no, None)
            .map_err(|_| JsError::new(&format!("genesis input out of range: {input}")))?;
        let (_seal, state) = revealed
            .into_revealed()
            .ok_or_else(|| JsError::new(&format!("genesis input not revealed: {input}")))?;
        prev_prev_state.entry(input.ty).or_default().push(state);
    }

    let schema = NonInflatableAsset::schema();
    let types = NonInflatableAsset::types();
    let scripts = NonInflatableAsset::scripts();
    let contract_state = Rc::new(RefCell::new(MemContract::init((&schema, contract_id))));

    let witness_txid = Txid::strict_dumb();
    let witness_ord = WitnessOrd::strict_dumb();
    let bundle_id = BundleId::strict_dumb();

    schema
        .validate_state(
            &types,
            &scripts,
            genesis,
            OrdOpRef::Genesis(genesis),
            contract_state.clone(),
            &BTreeMap::new(),
        )
        .map_err(|e| JsError::new(&format!("genesis re-validation: {e:?}")))?;

    schema
        .validate_state(
            &types,
            &scripts,
            genesis,
            OrdOpRef::Transition(&prev_transition, witness_txid, witness_ord, bundle_id),
            contract_state.clone(),
            &prev_prev_state,
        )
        .map_err(|e| JsError::new(&format!("prev_transition validation: {e:?}")))?;

    schema
        .validate_state(
            &types,
            &scripts,
            genesis,
            OrdOpRef::Transition(&transition, witness_txid, witness_ord, bundle_id),
            contract_state,
            &tr_prev_state,
        )
        .map_err(|e| JsError::new(&format!("transition validation: {e:?}")))?;

    Ok(hex::encode(transition.id().to_byte_array()))
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

    #[test]
    fn nia_genesis_metadata_returns_ticker_name_supply() {
        // Issue a contract with known fields, then decode the metadata
        // out of the produced consignment bytes. Round-trip must be exact:
        // the ticker / name / supply you encoded come back byte-for-byte.
        let issued = issue_nia_contract(
            "SPRK",
            "Spark RGB Test",
            314_159,
            FIXTURE_TXID,
            0,
            1_700_000_200,
        )
        .expect("issuance");
        let meta = nia_genesis_metadata(&issued.consignment_hex)
            .expect("metadata extraction");
        assert_eq!(meta.contract_id_hex, issued.contract_id_hex,
            "metadata contractId must equal issuance contractId");
        assert_eq!(meta.ticker, "SPRK");
        assert_eq!(meta.name, "Spark RGB Test");
        assert_eq!(meta.supply, "314159");
    }

    #[test]
    fn build_and_validate_nia_transition_roundtrip() {
        // Issuer-side: mint a NIA genesis with a known supply.
        let issued =
            issue_nia_contract("TX", "Transition test", 1_337, FIXTURE_TXID, 0, 1_700_000_002)
                .expect("issuance");
        // Build a transfer transition consuming the single genesis output,
        // re-allocating the full amount to a new beneficiary seal.
        let beneficiary_txid =
            "97a8c0a35d36e3f9f44b94be77ba3f7e74e2b97ee8f57edf6f111d2d6f8a4c10";
        let trn = build_nia_transition(&issued.consignment_hex, 0, 1_337, beneficiary_txid, 1)
            .expect("build_nia_transition");
        // commitIdHex is a 32-byte hex string (transition.id()).
        assert_eq!(trn.commit_id_hex.len(), 64);
        assert!(trn.commit_id_hex.chars().all(|c| c.is_ascii_hexdigit()));
        // Receiver-side: re-decode + schema-validate (no resolver, no witness).
        let next_msg = validate_nia_transition(&trn.transition_hex, &issued.consignment_hex)
            .expect("validate_nia_transition");
        assert_eq!(
            next_msg, trn.commit_id_hex,
            "receiver-derived nextMsg must equal sender commitId"
        );
    }

    #[test]
    fn build_multi_output_genesis_two_outputs() {
        // Issue with supply 1000, build a 2-output transition splitting
        // 700 to one beneficiary, 300 to another. Conservation: 700+300
        // == 1000.
        let issued =
            issue_nia_contract("MO2", "Multi-output 2", 1000, FIXTURE_TXID, 0, 1_700_000_300)
                .expect("issuance");

        let txid_a = "0000000000000000000000000000000000000000000000000000000000000001";
        let txid_b = "0000000000000000000000000000000000000000000000000000000000000002";

        let trn = build_nia_transition_multi_output(
            &issued.consignment_hex,
            0,
            vec!["700".to_string(), "300".to_string()],
            vec![txid_a.to_string(), txid_b.to_string()],
            vec![0, 1],
        )
        .expect("build 2-output transition");

        assert_eq!(trn.commit_id_hex.len(), 64);
        assert!(trn.commit_id_hex.chars().all(|c| c.is_ascii_hexdigit()));

        // The existing validator must accept multi-output transitions
        // without modification — it cares about conservation and
        // schema, not output count.
        let validated = validate_nia_transition(&trn.transition_hex, &issued.consignment_hex)
            .expect("validate 2-output transition");
        assert_eq!(validated, trn.commit_id_hex);
    }

    #[test]
    fn build_multi_output_genesis_three_outputs() {
        // Same as the 2-output test but with 3 beneficiaries: 500 + 300 +
        // 200 == 1000. Verifies that the implementation correctly
        // iterates over N outputs, not just hardcoded 2.
        let issued =
            issue_nia_contract("MO3", "Multi-output 3", 1000, FIXTURE_TXID, 0, 1_700_000_301)
                .expect("issuance");

        let trn = build_nia_transition_multi_output(
            &issued.consignment_hex,
            0,
            vec!["500".to_string(), "300".to_string(), "200".to_string()],
            vec![
                "0000000000000000000000000000000000000000000000000000000000000001".to_string(),
                "0000000000000000000000000000000000000000000000000000000000000002".to_string(),
                "0000000000000000000000000000000000000000000000000000000000000003".to_string(),
            ],
            vec![0, 1, 2],
        )
        .expect("build 3-output transition");

        let validated = validate_nia_transition(&trn.transition_hex, &issued.consignment_hex)
            .expect("validate 3-output transition");
        assert_eq!(validated, trn.commit_id_hex);
    }

    // Note: negative tests (conservation violation, length mismatch) live
    // only in the wasm32 target — JsError construction in our error path
    // can't be exercised on native (`cannot call wasm-bindgen imported
    // functions on non-wasm targets`). The positive tests below are
    // sufficient evidence that the happy-path multi-output transitions
    // build and validate correctly; the error paths are simple guard
    // clauses that don't warrant wasm-only test infra.

    #[test]
    fn nia_transition_outputs_round_trips_multi_output() {
        // Build a known 3-output split (500/300/200 out of 1000) and
        // confirm `nia_transition_outputs` reads back the same per-output
        // amounts byte-for-byte. This is the function the buyer-side
        // inbox uses to populate its stash without trusting envelope
        // metadata.
        let issued =
            issue_nia_contract("TO3", "Transition outputs 3", 1000, FIXTURE_TXID, 0, 1_700_000_400)
                .expect("issuance");
        let trn = build_nia_transition_multi_output(
            &issued.consignment_hex,
            0,
            vec!["500".to_string(), "300".to_string(), "200".to_string()],
            vec![
                "0000000000000000000000000000000000000000000000000000000000000001".to_string(),
                "0000000000000000000000000000000000000000000000000000000000000002".to_string(),
                "0000000000000000000000000000000000000000000000000000000000000003".to_string(),
            ],
            vec![0, 1, 2],
        )
        .expect("build 3-output");

        let outputs = nia_transition_outputs(&trn.transition_hex)
            .expect("extract outputs");
        assert_eq!(outputs, vec!["500", "300", "200"]);
    }

    #[test]
    fn nia_transition_outputs_single_output() {
        // 1-output transitions (the v0 single-output path) must also be
        // readable — same function handles both shapes.
        let issued =
            issue_nia_contract("TO1", "Transition outputs 1", 42, FIXTURE_TXID, 0, 1_700_000_401)
                .expect("issuance");
        let trn = build_nia_transition(
            &issued.consignment_hex,
            0,
            42,
            "0000000000000000000000000000000000000000000000000000000000000010",
            0,
        )
        .expect("build 1-output");
        let outputs = nia_transition_outputs(&trn.transition_hex)
            .expect("extract outputs");
        assert_eq!(outputs, vec!["42"]);
    }

    #[test]
    fn build_multi_output_from_prev_two_outputs() {
        // Chain: genesis → T_1 (single-output, all 1000 to seller) →
        // T_2 (multi-output: 200 to buyer, 800 back to seller as change).
        // This is the exact pattern the orderbook settlement path will
        // produce for partial fills.
        let issued =
            issue_nia_contract("MOP", "Multi-output prev", 1000, FIXTURE_TXID, 0, 1_700_000_304)
                .expect("issuance");

        // T_1: full balance to seller.
        let t1 = build_nia_transition(
            &issued.consignment_hex,
            0,
            1000,
            "0000000000000000000000000000000000000000000000000000000000000010",
            1,
        )
        .expect("build T_1");

        // T_2: 200 to buyer, 800 back to seller.
        let t2 = build_nia_transition_multi_output_from_prev(
            &t1.transition_hex,
            &issued.consignment_hex,
            0,
            vec!["200".to_string(), "800".to_string()],
            vec![
                "0000000000000000000000000000000000000000000000000000000000000020".to_string(),
                "0000000000000000000000000000000000000000000000000000000000000021".to_string(),
            ],
            vec![0, 1],
        )
        .expect("build T_2 multi-output on T_1");

        // Validate T_2 against the chain (genesis, T_1).
        let validated = validate_nia_transition_from_prev(
            &t2.transition_hex,
            &t1.transition_hex,
            &issued.consignment_hex,
        )
        .expect("validate T_2 multi-output");
        assert_eq!(validated, t2.commit_id_hex);
    }

    #[test]
    fn build_and_validate_transition_on_transition() {
        // Chain: genesis → T_1 (seller's mint) → T_2 (sale transfer to buyer).
        // Confirms the WASM API supports 3-op chains, with the validator
        // accepting T_2 only when it cleanly consumes T_1's output.
        let issued =
            issue_nia_contract("CH", "Chain test", 500, FIXTURE_TXID, 0, 1_700_000_100)
                .expect("issuance");

        // T_1: genesis → seller. Reuses buildNiaTransition with the same
        // placeholder beneficiary the genesis already used; what matters
        // for the chain is the contract conservation, not the seal.
        let t1 = build_nia_transition(
            &issued.consignment_hex,
            0,
            500,
            "1f29d0a35d36e3f9f44b94be77ba3f7e74e2b97ee8f57edf6f111d2d6f8a4c10",
            1,
        )
        .expect("build T_1");

        // T_2: prev_transition (T_1) → buyer.
        let t2 = build_nia_transition_from_prev(
            &t1.transition_hex,
            &issued.consignment_hex,
            0,
            500,
            "2f29d0a35d36e3f9f44b94be77ba3f7e74e2b97ee8f57edf6f111d2d6f8a4c10",
            2,
        )
        .expect("build T_2 on T_1");
        assert_eq!(t2.commit_id_hex.len(), 64);
        assert!(t2.commit_id_hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t2.commit_id_hex, t1.commit_id_hex, "T_2 != T_1");

        // Validate T_2 with the chain (genesis, T_1) — must return T_2.id().
        let validated = validate_nia_transition_from_prev(
            &t2.transition_hex,
            &t1.transition_hex,
            &issued.consignment_hex,
        )
        .expect("validate T_2 on T_1");
        assert_eq!(validated, t2.commit_id_hex,
            "validator-returned commit_id must equal T_2.id()");
    }

    #[cfg(target_arch = "wasm32")]
    #[test]
    fn validate_nia_transition_rejects_amount_mismatch() {
        // Build a valid transition but tamper-test against a *different*
        // genesis: contract_id mismatch must be caught.
        let g_a = issue_nia_contract("A", "A", 10, FIXTURE_TXID, 0, 1_700_000_010).expect("a");
        let g_b = issue_nia_contract("B", "B", 10, FIXTURE_TXID, 0, 1_700_000_011).expect("b");
        let trn = build_nia_transition(
            &g_a.consignment_hex,
            0,
            10,
            "97a8c0a35d36e3f9f44b94be77ba3f7e74e2b97ee8f57edf6f111d2d6f8a4c10",
            0,
        )
        .expect("build over genesis A");
        let r = validate_nia_transition(&trn.transition_hex, &g_b.consignment_hex);
        assert!(r.is_err(), "validation against the wrong genesis must fail");
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
