// RgbAwareSparkSigner — custom Spark signer that applies a Spark-UTK
// tweak to leaf keys so the leaf's verifyingPublicKey cryptographically
// commits to an RGB Merkle root.
//
// Construction (mirrors forks/bp-core/dbc/src/keytweak/mod.rs):
//
//   t          = tagged_hash("Spark-RGB-UTK-v1", U_base ‖ msg)   // 32 bytes BE
//   priv_tweak = (priv + t) mod n
//   U_tweaked  = U_base + t·G    (which equals pubkey(priv_tweak))
//
// Scoping (rev v2, 2026-05-12):
// Earlier (v1) we gated on a single global intent + `keyDerivation.type === LEAF`.
// That gate is too coarse — `LEAF`-typed derivations also fire for:
//   (a) deposit finalization (L1-pinned to U_base; tweaking breaks the SE owner check)
//   (b) source-leaf authorization during outbound transfers (must stay vanilla
//       to match the SE's on-record verifyingKey of the leaf being spent)
// Both above must remain vanilla. Only the *receiver-side new-leaf pubkey
// declaration* during `claimTransferCore` is a free destination key the SE
// will persist for us — that's where the tweak should fire.
//
// The discriminator the SDK gives us is just `{ type: LEAF, path: leafId }`.
// We can't tell from inside the signer whether this call is "I'm proving
// ownership of leaf X" or "I'm declaring my pubkey for new leaf X". So the
// gating is moved outside: the caller (mintViaSelfTransfer in sparkWallet.ts)
// adds `leafId → msg` to `pathTweaks` ONLY for the brief window of the claim,
// then removes it. Any `LEAF` derivation hitting the signer with a path that
// happens to be in `pathTweaks` at that instant gets tweaked.

import { DefaultSparkSigner } from '@buildonspark/spark-sdk';
import { KeyDerivationType } from '@buildonspark/spark-sdk';
import type { KeyDerivation } from '@buildonspark/spark-sdk';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

const SPARK_UTK_TAG = 'Spark-RGB-UTK-v1';
const TEXT_ENCODER = new TextEncoder();

// path -> msg. Owned by sparkWallet's mint flow which adds/removes entries
// within the strict claim window. Empty = signer is fully vanilla.
const pathTweaks = new Map<string, Uint8Array>();

export function setPathTweak(path: string, msg: Uint8Array): void {
  if (msg.length !== 32) {
    throw new Error(`RGB tweak msg must be 32 bytes, got ${msg.length}`);
  }
  pathTweaks.set(path, msg);
}

export function clearPathTweak(path: string): void {
  pathTweaks.delete(path);
}

export function clearAllPathTweaks(): void {
  pathTweaks.clear();
}

export function getPathTweak(path: string): Uint8Array | null {
  return pathTweaks.get(path) ?? null;
}

// Legacy compat. Pre-v2 flow used a single global intent; the only remaining
// consumer is the (now removed) UTK-at-claim Mint UI and any defensive
// clear-before-claim guards. We keep them as no-ops so older call sites stay
// compile-safe but do nothing.
export function setRgbIntent(_msg: Uint8Array): void {
  // intentionally no-op in v2; use setPathTweak(leafId, msg) instead
}

export function clearRgbIntent(): void {
  // intentionally no-op in v2
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

function tweakScalar(uBase: Uint8Array, msg: Uint8Array): bigint {
  const hashInput = new Uint8Array(uBase.length + msg.length);
  hashInput.set(uBase, 0);
  hashInput.set(msg, uBase.length);
  const tBytes = taggedHash(SPARK_UTK_TAG, hashInput);
  return bytesToBigInt(tBytes) % secp256k1.CURVE.n;
}

/**
 * Apply the Spark-UTK additive tweak on the private-key side.
 *
 * Returns `(basePriv + tagged_hash("Spark-RGB-UTK-v1", U_base‖msg)) mod n`
 * as a 32-byte big-endian secret key. Throws if the result is zero.
 */
export function tweakPrivateKey(basePriv: Uint8Array, msg: Uint8Array): Uint8Array {
  if (basePriv.length !== 32) throw new Error(`basePriv must be 32 bytes, got ${basePriv.length}`);
  if (msg.length !== 32) throw new Error(`msg must be 32 bytes, got ${msg.length}`);

  const uBase = secp256k1.getPublicKey(basePriv, true);
  const t = tweakScalar(uBase, msg);
  const priv = bytesToBigInt(basePriv);
  const tweaked = (priv + t) % secp256k1.CURVE.n;
  if (tweaked === 0n) {
    throw new Error('Spark-UTK tweak produced a zero scalar');
  }
  return bigIntToBytes32(tweaked);
}

/**
 * Apply the Spark-UTK additive tweak on the public-key side.
 *
 * Returns `U_base + t·G` as a 33-byte compressed pubkey, where
 * `t = tagged_hash("Spark-RGB-UTK-v1", U_base‖msg)`.
 *
 * Equivalent (and provably equal) to `pubkey(tweakPrivateKey(basePriv, msg))`,
 * but lets the signer act on `getPublicKeyFromDerivation` without re-deriving
 * via the private key path.
 */
export function tweakPublicKey(uBase: Uint8Array, msg: Uint8Array): Uint8Array {
  if (uBase.length !== 33) throw new Error(`uBase must be 33 bytes compressed, got ${uBase.length}`);
  if (msg.length !== 32) throw new Error(`msg must be 32 bytes, got ${msg.length}`);

  const t = tweakScalar(uBase, msg);
  if (t === 0n) {
    throw new Error('Spark-UTK tweak produced a zero scalar');
  }
  const basePoint = secp256k1.Point.fromHex(uBase);
  const tweakedPoint = basePoint.add(secp256k1.Point.BASE.multiply(t));
  return tweakedPoint.toRawBytes(true);
}

function lookupTweak(keyDerivation: KeyDerivation): Uint8Array | null {
  if (keyDerivation.type !== KeyDerivationType.LEAF) return null;
  return pathTweaks.get(keyDerivation.path) ?? null;
}

export class RgbAwareSparkSigner extends DefaultSparkSigner {
  protected async getSigningPrivateKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    const basePriv = await super.getSigningPrivateKeyFromDerivation(keyDerivation);
    const msg = lookupTweak(keyDerivation);
    if (!msg) return basePriv;
    return tweakPrivateKey(basePriv, msg);
  }

  async getPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    const basePub = await super.getPublicKeyFromDerivation(keyDerivation);
    const msg = lookupTweak(keyDerivation);
    if (!msg) return basePub;
    return tweakPublicKey(basePub, msg);
  }
}
