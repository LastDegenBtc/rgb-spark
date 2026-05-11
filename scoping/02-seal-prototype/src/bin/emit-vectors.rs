//! Emit the deterministic test vector that backs `03-test-vectors.md`.
//!
//!     cargo run --bin emit-vectors
//!
//! Pipe the output verbatim into `03-test-vectors.md`. Do NOT hand-edit
//! the vectors there — keep this binary as the single source of truth.

use secp256k1::{Secp256k1, SecretKey};
use spark_utk_prototype::derive_spark_utk;

fn main() {
    let secp = Secp256k1::new();

    let u_base = SecretKey::from_slice(&[0x11u8; 32]).unwrap().public_key(&secp);
    let operator = SecretKey::from_slice(&[0x22u8; 32]).unwrap().public_key(&secp);
    let m = [0x33u8; 32];

    let out = derive_spark_utk(&u_base, &m, &operator);

    println!("# Spark-UTK v1 — deterministic test vector");
    println!();
    println!("## Inputs");
    println!("- u_base_sk      = 0x11..11 (32 bytes filler)");
    println!("- u_base         = {}", hex::encode(u_base.serialize()));
    println!("- operator_sk    = 0x22..22 (32 bytes filler)");
    println!("- operator       = {}", hex::encode(operator.serialize()));
    println!("- m              = {}", hex::encode(m));
    println!();
    println!("## Outputs");
    println!("- u_tweaked      = {}", hex::encode(out.u_tweaked.serialize()));
    println!("- verifying_key  = {}", hex::encode(out.verifying_key.serialize()));
    println!("- output_xonly   = {}", hex::encode(out.output_xonly));
}
