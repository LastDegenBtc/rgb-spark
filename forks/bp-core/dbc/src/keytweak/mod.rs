// Deterministic bitcoin commitments library.
//
// SPDX-License-Identifier: Apache-2.0
//
// Written in 2019-2024 by
//     Dr Maxim Orlovsky <orlovsky@lnp-bp.org>
// 2026 Spark-UTK addition by PPRGB.
//
// Copyright (C) 2019-2024 LNP/BP Standards Association. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Homomorphic key tweaking-based deterministic commitment scheme.
//!
//! **Embed-commit:**
//! a) `PublicKey, Msg -> PublicKey', PublicKey`;
//! b) `Set<PublicKey>, Msg -> Set<PublicKey>', PublicKey`;
//! c) `LockScript, Msg -> LockScript', (LockScript, PublicKey)`;
//! d) `(psbt::Output, TxOut), Msg -> (psbt::Output, TxOut)', KeytweakProof`;
//! e) `PSBT, Msg -> PSBT', KeytweakProof`;
//! **Convolve-commit:**
//! d) `PubkeyScript, SpkDescriptor, Msg -> PubkeyScript'`;
//! e) `TxOut, SpkDescriptor, Msg -> TxOut'`;
//! f) `Tx, SpkDescriptor, Msg -> Tx'`;
//!
//! ## Spark-UTK
//!
//! The first concrete instance of this scheme is **Spark-UTK** (User-Key
//! Tweak), specified in companion RFC `SPARK-UTK.md` v0.2. It embeds an
//! RGB Merkle root into the user-side public key *before* the leaf's
//! FROST aggregation in Spark, so that the resulting `verifyingKey` —
//! and therefore the L1 unilateral-exit output — carries the commitment
//! without any change to the Spark protocol.
//!
//! Construction:
//! ```text
//! t         = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)
//! U_tweaked = U_base + t·G
//! V         = U_tweaked + operator           (FROST-style additive aggregation)
//! L1 output = p2tr(taproot_noscript(V_xonly), no-script)
//! ```
//!
//! Verification reconstructs the same chain from `(U_base, operator,
//! msg)` carried in [`SparkUtkProof`] and compares the derived L1 output
//! against the witness transaction.

use bc::{CompressedPk, OutputPk, ScriptPubkey, Tx};
use commit_verify::mpc::Commitment;
use commit_verify::{Digest, Sha256};
use secp256k1::{Scalar, Secp256k1};
use strict_encoding::{StrictDeserialize, StrictSerialize};

use crate::proof::Method;
use crate::{Proof, LIB_NAME_BPCORE};

/// BIP-340 tagged-hash domain tag for the Spark-UTK user-key tweak.
pub const SPARK_UTK_TAG: &str = "Spark-RGB-UTK-v1";

/// BIP-340 tagged-hash domain tag for the BIP-341 noscript taproot tweak.
pub const TAPROOT_TWEAK_TAG: &str = "TapTweak";

/// Errors that can occur during Spark-UTK verification.
#[derive(Clone, Eq, PartialEq, Debug, Display, Error)]
#[display(doc_comments)]
pub enum SparkUtkError {
    /// witness transaction has no p2tr output to verify the Spark-UTK seal against.
    NoP2trOutput,

    /// no p2tr output in the witness transaction matches the expected Spark-UTK output key.
    OutputKeyMismatch,

    /// the derived output xonly key is not a valid point: {0}
    InvalidOutputXonly(String),

    /// secp256k1 arithmetic failure during Spark-UTK derivation: {0}
    Secp(String),
}

/// Spark-UTK seal proof.
///
/// Carries the user-side base pubkey `U_base` and the Spark Service
/// operator-side aggregate pubkey. The message-dependent tweak `t` is
/// recomputed at verification time from the RGB Merkle root, so the
/// proof is constant-size irrespective of the committed state.
#[derive(Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Hash, Debug)]
#[derive(StrictType, StrictDumb, StrictEncode, StrictDecode)]
#[strict_type(lib = LIB_NAME_BPCORE)]
#[cfg_attr(
    feature = "serde",
    derive(Serialize, Deserialize),
    serde(crate = "serde_crate", rename_all = "camelCase")
)]
pub struct SparkUtkProof {
    /// User's base pubkey — the value the user would have submitted to
    /// the Spark Service in a vanilla (non-RGB) deposit.
    pub u_base: CompressedPk,

    /// Spark Service operator-side pubkey — returned by the SE on
    /// `generateDepositAddress`, kept in the leaf's published metadata.
    pub operator: CompressedPk,
}

impl StrictSerialize for SparkUtkProof {}
impl StrictDeserialize for SparkUtkProof {}

impl Proof<Method> for SparkUtkProof {
    type Error = SparkUtkError;

    fn method(&self) -> Method { Method::SparkUtk }

    fn verify(&self, msg: &Commitment, tx: &Tx) -> Result<(), Self::Error> {
        let expected_xonly = derive_output_xonly(&self.u_base, msg, &self.operator)?;
        let expected_pk = OutputPk::from_byte_array(expected_xonly)
            .map_err(|e| SparkUtkError::InvalidOutputXonly(format!("{e}")))?;
        let expected_spk = ScriptPubkey::p2tr_tweaked(expected_pk);

        let mut had_p2tr = false;
        for txout in &tx.outputs {
            if txout.script_pubkey.is_p2tr() {
                had_p2tr = true;
                if txout.script_pubkey == expected_spk {
                    return Ok(());
                }
            }
        }
        if had_p2tr {
            Err(SparkUtkError::OutputKeyMismatch)
        } else {
            Err(SparkUtkError::NoP2trOutput)
        }
    }
}

// ---- Derivation primitives ----

/// BIP-340 tagged hash: `SHA256(SHA256(tag) || SHA256(tag) || data)`.
pub fn tagged_hash(tag: &str, data: &[u8]) -> [u8; 32] {
    let tag_hash = Sha256::digest(tag.as_bytes());
    let mut h = Sha256::new();
    h.update(tag_hash);
    h.update(tag_hash);
    h.update(data);
    let result = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Compute `U_tweaked = U_base + t·G` where
/// `t = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)`.
pub fn derive_u_tweaked(
    u_base: &CompressedPk,
    msg_bytes: &[u8; 32],
) -> Result<CompressedPk, SparkUtkError> {
    let u_base_bytes = u_base.to_byte_array();
    let mut data = Vec::with_capacity(33 + 32);
    data.extend_from_slice(&u_base_bytes);
    data.extend_from_slice(msg_bytes);
    let t_bytes = tagged_hash(SPARK_UTK_TAG, &data);
    let scalar = Scalar::from_be_bytes(t_bytes)
        .map_err(|e| SparkUtkError::Secp(format!("scalar from hash: {e}")))?;
    let secp = Secp256k1::new();
    let u_tweaked_pk = u_base
        .add_exp_tweak(&secp, &scalar)
        .map_err(|e| SparkUtkError::Secp(format!("add_exp_tweak: {e}")))?;
    CompressedPk::from_byte_array(u_tweaked_pk.serialize())
        .map_err(|e| SparkUtkError::Secp(format!("compress tweaked: {e}")))
}

/// Compute the leaf's `verifyingKey = (U_base + t·G) + operator`.
pub fn derive_verifying_key(
    u_base: &CompressedPk,
    msg_bytes: &[u8; 32],
    operator: &CompressedPk,
) -> Result<CompressedPk, SparkUtkError> {
    let u_tweaked = derive_u_tweaked(u_base, msg_bytes)?;
    let v_pk = u_tweaked
        .combine(operator)
        .map_err(|e| SparkUtkError::Secp(format!("combine: {e}")))?;
    CompressedPk::from_byte_array(v_pk.serialize())
        .map_err(|e| SparkUtkError::Secp(format!("compress verifying key: {e}")))
}

/// Compute the BIP-341 noscript-tweaked output xonly key for a Spark-UTK
/// L1 unilateral exit, given the Spark-UTK proof inputs and the RGB
/// commitment.
pub fn derive_output_xonly(
    u_base: &CompressedPk,
    msg: &Commitment,
    operator: &CompressedPk,
) -> Result<[u8; 32], SparkUtkError> {
    let msg_bytes: [u8; 32] = msg.to_byte_array();
    let v = derive_verifying_key(u_base, &msg_bytes, operator)?;
    let (v_xonly, _) = v.x_only_public_key();
    let tap_tweak = tagged_hash(TAPROOT_TWEAK_TAG, &v_xonly.serialize());
    let scalar = Scalar::from_be_bytes(tap_tweak)
        .map_err(|e| SparkUtkError::Secp(format!("tap-scalar: {e}")))?;
    let secp = Secp256k1::new();
    let (output_xonly_pk, _) = v_xonly
        .add_tweak(&secp, &scalar)
        .map_err(|e| SparkUtkError::Secp(format!("tap add_tweak: {e}")))?;
    Ok(output_xonly_pk.serialize())
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use secp256k1::{PublicKey, Secp256k1, SecretKey};

    use super::*;

    fn pk_from_filler(byte: u8) -> CompressedPk {
        let secp = Secp256k1::new();
        let sk = SecretKey::from_slice(&[byte; 32]).unwrap();
        let pk: PublicKey = sk.public_key(&secp);
        CompressedPk::from_byte_array(pk.serialize()).unwrap()
    }

    fn commitment_from_byte(byte: u8) -> Commitment {
        let bytes = [byte; 32];
        Commitment::from(bytes)
    }

    /// Vector pinned in `spark-rgb/scoping/03-test-vectors.md`, also
    /// reproduced byte-for-byte by `spark-rgb/scoping/04-repro-ts/`.
    /// Match against this is the single most important property of this
    /// module — it is what proves the integrated implementation matches
    /// the isolated prototype.
    #[test]
    fn deterministic_vector_v1() {
        let u_base = pk_from_filler(0x11);
        let operator = pk_from_filler(0x22);
        let msg = commitment_from_byte(0x33);
        let msg_bytes: [u8; 32] = msg.to_byte_array();

        let u_tweaked = derive_u_tweaked(&u_base, &msg_bytes).unwrap();
        let verifying_key =
            derive_verifying_key(&u_base, &msg_bytes, &operator).unwrap();
        let output_xonly = derive_output_xonly(&u_base, &msg, &operator).unwrap();

        let want_u_tweaked = CompressedPk::from_str(
            "02590567584842f153cc63e4ec8447e543900ff8c26f15f21a51e1996fb8a1e6e8",
        )
        .unwrap();
        let want_verifying_key = CompressedPk::from_str(
            "02d4632ae349ef45b121f35e9bc414efd4fdbc9ecf58e1cbe084ccf8469226853c",
        )
        .unwrap();
        let want_output_xonly: [u8; 32] = [
            0x5b, 0xd9, 0xbe, 0x28, 0x9c, 0x4d, 0x49, 0x49, 0xea, 0x85, 0x16, 0x9a, 0x2c, 0x5e,
            0x90, 0x5d, 0x07, 0x78, 0xfd, 0xc5, 0x0b, 0xba, 0x06, 0xe4, 0x7d, 0xcb, 0x33, 0x11,
            0xb7, 0x79, 0x2e, 0x50,
        ];

        assert_eq!(
            u_tweaked, want_u_tweaked,
            "U_tweaked must match the cross-language vector"
        );
        assert_eq!(
            verifying_key, want_verifying_key,
            "verifyingKey must match the cross-language vector"
        );
        assert_eq!(
            output_xonly, want_output_xonly,
            "output xonly must match the cross-language vector"
        );
    }

    #[test]
    fn proof_method_is_sparkutk() {
        let proof = SparkUtkProof {
            u_base: pk_from_filler(0x11),
            operator: pk_from_filler(0x22),
        };
        assert_eq!(proof.method(), Method::SparkUtk);
    }

    #[test]
    fn tagged_hash_domain_separation() {
        // Sanity: the BIP-340 tagged hash of an empty message under our
        // tag is deterministic; once pinned here, any drift is caught.
        let h = tagged_hash(SPARK_UTK_TAG, &[]);
        let secp_tag = Sha256::digest(SPARK_UTK_TAG.as_bytes());
        let mut hh = Sha256::new();
        hh.update(secp_tag);
        hh.update(secp_tag);
        let want = hh.finalize();
        assert_eq!(&h, want.as_slice());
    }
}
