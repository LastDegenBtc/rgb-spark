// Browser-side primitives for Spark-UTK + RGB on Spark.
//
// Phase 1B WASM bindings. Exposes the four Spark-UTK derivation
// functions used by the wallet on the client side plus a wasm-bindgen
// wrapper around [`SparkUtkProof`] that strict-encodes to the same
// bytes the validator (in rgb-consensus) expects.

use amplify::confinement::Confined;
use bc::CompressedPk;
use commit_verify::mpc::Commitment;
// Lib-name (not package-name) gotcha: bp-consensus → bc, bp-dbc → dbc.
use dbc::keytweak::{self, SparkUtkProof};
use strict_encoding::{StrictDeserialize, StrictSerialize};
use wasm_bindgen::prelude::*;

// SparkUtkProof is two 33-byte pubkeys plus strict-encoding overhead;
// 1 KiB is a comfortable ceiling that costs us nothing in the bundle.
const PROOF_MAX_LEN: usize = 1024;

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
}
