// RgbAwareSparkSigner — custom Spark signer that applies a Spark-UTK
// tweak to leaf private keys so the leaf's verifying key cryptographically
// commits to an RGB Merkle root.
//
// Construction (mirrors forks/bp-core/dbc/src/keytweak/mod.rs):
//
//   t          = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)   // 32 bytes BE
//   priv_tweak = (priv + t) mod n
//   U_tweaked  = U_base + t·G    (which equals pubkey(priv_tweak))
//
// We override the single internal hook `getSigningPrivateKeyFromDerivation`
// (signer.ts:330 in @buildonspark/spark-sdk) — it's the one chokepoint feeding
// every leaf signing path (getPublicKeyFromDerivation, buildSignFrostParams,
// subtractAndSplit*). Tweak the private key there and the public key the SE
// receives, plus every FROST co-signature the wallet later produces, all
// align on U_tweaked automatically.
//
// Gate: tweak fires only when an RGB intent is set AND the derivation type is
// LEAF. DEPOSIT / STATIC_DEPOSIT / ECIES / RANDOM stay vanilla — they're not
// leaf-bound and tweaking them would break the wallet's L1 deposit path.

import { DefaultSparkSigner } from '@buildonspark/spark-sdk';
import { KeyDerivationType } from '@buildonspark/spark-sdk';
import type { KeyDerivation } from '@buildonspark/spark-sdk';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

const SPARK_UTK_TAG = 'Spark-RGB-UTK-v1';
const TEXT_ENCODER = new TextEncoder();

let currentRgbMsg: Uint8Array | null = null;

export function setRgbIntent(msg: Uint8Array): void {
  if (msg.length !== 32) {
    throw new Error(`RGB intent msg must be 32 bytes, got ${msg.length}`);
  }
  currentRgbMsg = msg;
}

export function clearRgbIntent(): void {
  currentRgbMsg = null;
}

export function getRgbIntent(): Uint8Array | null {
  return currentRgbMsg;
}

// BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data).
function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(TEXT_ENCODER.encode(tag));
  const buf = new Uint8Array(tagHash.length * 2 + data.length);
  buf.set(tagHash, 0);
  buf.set(tagHash, tagHash.length);
  buf.set(data, tagHash.length * 2);
  return sha256(buf);
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function bigIntToBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Apply the Spark-UTK additive tweak on the private-key side.
 *
 * Returns `(basePriv + tagged_hash("Spark-RGB-UTK-v1", U_base‖msg)) mod n`
 * as a 32-byte big-endian secret key.
 *
 * Throws if the result is zero (negligible probability, but secp256k1 forbids
 * a zero scalar as a secret key).
 */
export function tweakPrivateKey(basePriv: Uint8Array, msg: Uint8Array): Uint8Array {
  if (basePriv.length !== 32) throw new Error(`basePriv must be 32 bytes, got ${basePriv.length}`);
  if (msg.length !== 32) throw new Error(`msg must be 32 bytes, got ${msg.length}`);

  const uBase = secp256k1.getPublicKey(basePriv, true); // 33-byte compressed
  const hashInput = new Uint8Array(uBase.length + msg.length);
  hashInput.set(uBase, 0);
  hashInput.set(msg, uBase.length);

  const tBytes = taggedHash(SPARK_UTK_TAG, hashInput);
  const n = secp256k1.CURVE.n;
  const t = bytesToBigInt(tBytes) % n;
  const priv = bytesToBigInt(basePriv);
  const tweaked = (priv + t) % n;
  if (tweaked === 0n) {
    throw new Error('Spark-UTK tweak produced a zero scalar');
  }
  return bigIntToBytes32(tweaked);
}

export class RgbAwareSparkSigner extends DefaultSparkSigner {
  protected async getSigningPrivateKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    const basePriv = await super.getSigningPrivateKeyFromDerivation(keyDerivation);
    if (currentRgbMsg === null) return basePriv;
    if (keyDerivation.type !== KeyDerivationType.LEAF) return basePriv;
    return tweakPrivateKey(basePriv, currentRgbMsg);
  }
}
