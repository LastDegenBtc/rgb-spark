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
// Scoping (rev v3, 2026-05-12):
// v1 (global intent) was too coarse — tweaking fired for deposit finalization
// and for source-leaf signing during outbound transfers, both of which must
// stay vanilla.
// v2 (path-scoped, transient) tweaked only when the SDK asked for a specific
// leafId that we'd flagged. Worked for the mint moment itself but the tweaked
// leaf disappeared on every subsequent `getLeaves()` / `sync()` — the SDK's
// verifyKey filter asked the signer for `{LEAF, path: newLeafId}` and got a
// vanilla pubkey back (because base derivation from `sha256(newLeafId)` is
// totally different from the U_base we'd tweaked).
//
// v3 makes pathTweaks **persistent and indirect**:
//   pathTweaks: Map<currentLeafId, { sourcePath, msg }>
// The signer derives the base private key from `sourcePath` (the leaf id we
// originally tweaked against) and applies the same `tweakScalar(U_base, msg)`,
// so we can return U_tweaked when asked for path=newLeafId. The map persists
// for the lifetime of the wallet — see [[project_spark_leaf_validity_check]].
//
// Two kinds of entries live in the map:
//   - **Self-referencing** (sourcePath == currentLeafId): set briefly during
//     a mint, when the SDK asks for the destination pubkey via the source
//     leaf's id. Removed once claim returns.
//   - **Indirect** (sourcePath != currentLeafId): set after the SE confirms
//     the new leaf id, so future getLeaves/sync calls keep returning U_tweaked.
//     Stays until the leaf is spent.

import { DefaultSparkSigner } from '@buildonspark/spark-sdk';
import { KeyDerivationType } from '@buildonspark/spark-sdk';
import type { KeyDerivation } from '@buildonspark/spark-sdk';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

const SPARK_UTK_TAG = 'Spark-RGB-UTK-v1';
const TEXT_ENCODER = new TextEncoder();

export interface PathTweakEntry {
  sourcePath: string;
  msg: Uint8Array;
  /** Pre-mint `U_base` of the source leaf — captured at mint time so that
   *  proof builders (ConsignmentLab leaf-mode) can reconstruct the
   *  Spark-UTK relation `verifyingKey = U_base + tagged_hash(U_base‖msg)·G + operator`
   *  without re-querying the signer. Stored as 33-byte compressed pubkey bytes. */
  uBase: Uint8Array;
  /** Optional RGB consignment (hex) whose contractId == msg. Present only
   *  when the leaf was minted bound to a real RGB issuance via
   *  IssueNiaInline. Lets the sender attach the consignment to the
   *  Spark-UTK proof so the receiver can validate the RGB layer
   *  client-side via `core.validateNiaConsignment` and cross-check that
   *  its contractId matches the msg the Spark leaf committed to. */
  consignmentHex?: string;
}

// currentLeafId -> { sourcePath, msg }. The signer reads this map to decide
// whether (and how) to tweak any LEAF derivation call. Empty = fully vanilla.
const pathTweaks = new Map<string, PathTweakEntry>();

// Optional callback fired whenever pathTweaks mutates — lets a higher layer
// (App boot) persist the map to localStorage without coupling the signer to
// browser APIs.
type PersistenceListener = (entries: ReadonlyMap<string, PathTweakEntry>) => void;
let onChange: PersistenceListener | null = null;
export function setPathTweaksPersistenceListener(cb: PersistenceListener | null): void {
  onChange = cb;
}
function notifyChange(): void {
  if (onChange) onChange(pathTweaks);
}

export function setPathTweak(
  currentLeafId: string,
  sourcePath: string,
  msg: Uint8Array,
  uBase: Uint8Array,
  consignmentHex?: string,
): void {
  if (msg.length !== 32) {
    throw new Error(`RGB tweak msg must be 32 bytes, got ${msg.length}`);
  }
  if (uBase.length !== 33) {
    throw new Error(`RGB tweak uBase must be 33 bytes compressed, got ${uBase.length}`);
  }
  pathTweaks.set(currentLeafId, { sourcePath, msg, uBase, consignmentHex });
  notifyChange();
}

export function clearPathTweak(currentLeafId: string): void {
  if (pathTweaks.delete(currentLeafId)) notifyChange();
}

export function clearAllPathTweaks(): void {
  if (pathTweaks.size === 0) return;
  pathTweaks.clear();
  notifyChange();
}

export function getPathTweak(currentLeafId: string): PathTweakEntry | null {
  return pathTweaks.get(currentLeafId) ?? null;
}

export function listPathTweaks(): Array<{ currentLeafId: string } & PathTweakEntry> {
  return Array.from(pathTweaks.entries()).map(([currentLeafId, e]) => ({
    currentLeafId,
    sourcePath: e.sourcePath,
    msg: e.msg,
    uBase: e.uBase,
    consignmentHex: e.consignmentHex,
  }));
}

/**
 * Restore pathTweaks from a persisted snapshot — used at wallet boot after
 * decrypting localStorage. Does NOT trigger the persistence listener (would
 * cause a redundant rewrite).
 */
export function restorePathTweaks(
  entries: Array<{
    currentLeafId: string;
    sourcePath: string;
    msg: Uint8Array;
    uBase: Uint8Array;
    consignmentHex?: string;
  }>,
): void {
  pathTweaks.clear();
  for (const { currentLeafId, sourcePath, msg, uBase, consignmentHex } of entries) {
    pathTweaks.set(currentLeafId, { sourcePath, msg, uBase, consignmentHex });
  }
  // Intentionally skip notifyChange.
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

function lookupTweak(keyDerivation: KeyDerivation): PathTweakEntry | null {
  if (keyDerivation.type !== KeyDerivationType.LEAF) return null;
  return pathTweaks.get(keyDerivation.path) ?? null;
}

export class RgbAwareSparkSigner extends DefaultSparkSigner {
  // Single chokepoint: tweak only the private-key derivation. The base
  // `getPublicKeyFromDerivation` impl re-dispatches to this method via
  // `this.getSigningPrivateKeyFromDerivation()` and then calls
  // `secp256k1.getPublicKey()` on the result, so the pubkey side gets the
  // tweak transparently. Overriding BOTH (as we did in the first v3 cut)
  // produced a double-tweak — super.getPublicKeyFromDerivation would re-call
  // our subclass's getSigningPrivateKeyFromDerivation (already tweaked), then
  // we'd apply tweakPublicKey on top of an already-tweaked U_tweaked, giving
  // U_tweaked + tagged_hash(U_tweaked, msg)·G instead of U_tweaked. That
  // pubkey didn't match the SE record so verifyKey filtered the leaf out.
  protected async getSigningPrivateKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    const entry = lookupTweak(keyDerivation);
    if (!entry) {
      return super.getSigningPrivateKeyFromDerivation(keyDerivation);
    }
    // Derive the base private key from the ORIGINAL sourcePath (which binds
    // to the U_base the SE saw at mint time), then apply the additive tweak
    // with the stored msg. The pubkey side is handled by the default impl.
    const basePriv = await super.getSigningPrivateKeyFromDerivation({
      type: KeyDerivationType.LEAF,
      path: entry.sourcePath,
    });
    return tweakPrivateKey(basePriv, entry.msg);
  }

  /**
   * Compute the vanilla (untweaked) pubkey for a derivation path — bypassing
   * any pathTweaks entry. Used by `mintViaSelfTransfer` to capture the true
   * `U_base` that the SE will combine with the operator share at claim time,
   * when the source leaf may itself have a previous tweak (in which case
   * `sourceLeaf.ownerSigningPublicKey` is U_tweaked_old, not the vanilla
   * base — wrong material for the proof).
   *
   * Calls super.getSigningPrivateKeyFromDerivation DIRECTLY (not through
   * super.getPublicKeyFromDerivation, which would re-dispatch to our
   * subclass override via `this`). The base impl is a pure HD derivation
   * with no pathTweaks lookup, so the returned pubkey is always vanilla.
   */
  async getVanillaPublicKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    const priv = await super.getSigningPrivateKeyFromDerivation(keyDerivation);
    return secp256k1.getPublicKey(priv, true);
  }
}
