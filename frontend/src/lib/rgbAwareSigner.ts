// RgbAwareSparkSigner — custom Spark signer that can apply a Spark-UTK
// tweak to leaf private keys so the leaf's verifying key cryptographically
// commits to an RGB Merkle root.
//
// Session 1 (this file, scope-limited):
//   - Subclass DefaultSparkSigner.
//   - Override the single internal hook `getSigningPrivateKeyFromDerivation`.
//   - No tweak yet: pure passthrough when no intent is set, log + passthrough
//     when an intent IS set. Goal is to prove the signer is wirable into
//     SparkWallet.initialize without breaking the existing 9c-α flow.
//
// Session 2 (TODO): when `currentRgbMsg` is non-null AND the derivation is a
// LEAF derivation, return `(basePriv + t) mod n` where
//   t = tagged_hash("Spark-RGB-UTK-v1", U_base || msg)
//   U_base = secp256k1.getPublicKey(basePriv)
// All downstream signing flows (signFrost, subtract/split, etc.) inherit the
// tweak automatically because they all read the private key through this one
// hook. See scoping/05-spark-sdk-leaf-surface.md for the surface map.

import { DefaultSparkSigner } from '@buildonspark/spark-sdk';
import type { KeyDerivation } from '@buildonspark/spark-sdk';

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

export class RgbAwareSparkSigner extends DefaultSparkSigner {
  protected async getSigningPrivateKeyFromDerivation(
    keyDerivation: KeyDerivation,
  ): Promise<Uint8Array> {
    const basePriv = await super.getSigningPrivateKeyFromDerivation(keyDerivation);
    if (currentRgbMsg === null) {
      return basePriv;
    }
    // Intent is set but tweak is not implemented yet (Session 2). Pass through
    // so the wallet stays usable; log so we can confirm the hook fired during
    // a transfer.
    console.warn(
      '[RgbAwareSparkSigner] RGB intent set but tweak not yet implemented — passing through.',
      { derivationType: keyDerivation.type, msgHexPrefix: hexPrefix(currentRgbMsg) },
    );
    return basePriv;
  }
}

function hexPrefix(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < Math.min(8, b.length); i++) s += b[i].toString(16).padStart(2, '0');
  return s + '…';
}
