//! Spark-UTK seal closing math — isolated prototype.
//!
//! Implements the construction described in `SPARK-UTK.md` v0.2, with no
//! dependency on `bp-seals` or `rgb-lib`. The output is a deterministic
//! `(U_tweaked, V, output_xonly)` triple that any verifier can reconstruct
//! given `(U_base, m, operator_pubkey)`.
//!
//! When this is wired into the `bp-seals` fork in Phase 1, the
//! `derive_spark_utk` function below moves into the new
//! `SealCloseMethod::SparkUTK` verifier. The math does not change.

use secp256k1::{PublicKey, Scalar, Secp256k1};
use sha2::{Digest, Sha256};

/// Domain-separation tag for the user-key tweak. Versioned per RFC v0.2
/// so a future seal revision can coexist with v1 leaves.
pub const SPARK_UTK_TAG: &str = "Spark-RGB-UTK-v1";

/// BIP-341 taproot tweak tag.
pub const TAPROOT_TWEAK_TAG: &str = "TapTweak";

/// Output of the Spark-UTK derivation: every value a verifier needs.
#[derive(Debug, Clone)]
pub struct SparkUtkDerivation {
    /// `U_tweaked = U_base + t·G` — what the user submits to the Spark SE.
    pub u_tweaked: PublicKey,
    /// `V = U_tweaked + operator_pubkey` — the leaf's verifyingKey.
    pub verifying_key: PublicKey,
    /// `output_xonly = taproot_noscript(V_xonly)` — what appears on L1
    /// after a unilateral exit.
    pub output_xonly: [u8; 32],
}

/// BIP-340 tagged hash: `SHA256(SHA256(tag) || SHA256(tag) || data)`.
pub fn tagged_hash(tag: &str, data: &[u8]) -> [u8; 32] {
    let tag_hash = Sha256::digest(tag.as_bytes());
    let mut h = Sha256::new();
    h.update(tag_hash);
    h.update(tag_hash);
    h.update(data);
    h.finalize().into()
}

/// Run the full Spark-UTK derivation.
///
/// * `u_base` — user's base pubkey (the one they would have submitted
///   to the Spark SE in a vanilla deposit)
/// * `rgb_merkle_root` — `m`, the RGB Merkle root being committed to
/// * `operator_pubkey` — the SE-side aggregate, returned by Spark on
///   `generateDepositAddress`
pub fn derive_spark_utk(
    u_base: &PublicKey,
    rgb_merkle_root: &[u8; 32],
    operator_pubkey: &PublicKey,
) -> SparkUtkDerivation {
    let secp = Secp256k1::new();

    // 1. t = tagged_hash(SPARK_UTK_TAG, U_base ‖ m)
    let mut data = Vec::with_capacity(33 + 32);
    data.extend_from_slice(&u_base.serialize());
    data.extend_from_slice(rgb_merkle_root);
    let t_bytes = tagged_hash(SPARK_UTK_TAG, &data);
    let t_scalar = Scalar::from_be_bytes(t_bytes)
        .expect("tagged-hash output ≥ curve order: probability 2^-128, negligible");

    // 2. U_tweaked = U_base + t·G
    let u_tweaked = u_base
        .add_exp_tweak(&secp, &t_scalar)
        .expect("tweak yields point at infinity: negligible");

    // 3. V = U_tweaked + operator_pubkey   (additive, models FROST aggregation)
    let verifying_key = u_tweaked
        .combine(operator_pubkey)
        .expect("aggregation yields point at infinity: negligible");

    // 4. BIP-341 noscript tweak:
    //    output_key = V_xonly + tagged_hash("TapTweak", V_xonly)·G
    let (v_xonly, _) = verifying_key.x_only_public_key();
    let tap_tweak_bytes = tagged_hash(TAPROOT_TWEAK_TAG, &v_xonly.serialize());
    let tap_tweak_scalar = Scalar::from_be_bytes(tap_tweak_bytes)
        .expect("taproot tweak ≥ curve order: negligible");
    let (output_xonly_pk, _) = v_xonly
        .add_tweak(&secp, &tap_tweak_scalar)
        .expect("taproot tweak yields infinity: negligible");

    SparkUtkDerivation {
        u_tweaked,
        verifying_key,
        output_xonly: output_xonly_pk.serialize(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::SecretKey;

    /// Deterministic vector — pinned in `03-test-vectors.md`.
    /// Inputs are NUMS-style (single-byte fillers) so the vector is
    /// reproducible without any RNG state.
    #[test]
    fn deterministic_vector_v1() {
        let secp = Secp256k1::new();

        let u_base_sk = SecretKey::from_slice(&[0x11u8; 32]).unwrap();
        let u_base = u_base_sk.public_key(&secp);

        let op_sk = SecretKey::from_slice(&[0x22u8; 32]).unwrap();
        let operator = op_sk.public_key(&secp);

        let m = [0x33u8; 32];

        let out = derive_spark_utk(&u_base, &m, &operator);

        // Self-consistency: a second run must produce the same triple.
        let out2 = derive_spark_utk(&u_base, &m, &operator);
        assert_eq!(out.u_tweaked, out2.u_tweaked);
        assert_eq!(out.verifying_key, out2.verifying_key);
        assert_eq!(out.output_xonly, out2.output_xonly);

        // Sanity: U_tweaked != U_base (the tweak actually moved the point)
        assert_ne!(out.u_tweaked.serialize(), u_base.serialize());
    }
}
