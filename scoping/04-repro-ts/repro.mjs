// Spark-UTK — TS cross-language reproduction.
//
// Re-implements the same construction as `../02-seal-prototype/src/lib.rs`
// using @noble/secp256k1 + @noble/hashes (pure JS, no native deps).
//
// Goal: feed the same deterministic inputs and confirm byte-for-byte
// equality with the Rust vector pinned in `../03-test-vectors.md`.
// A match means the construction is portable across the two ecosystems
// we care about (Rust for the bp-seals fork, TS for the wallet).

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';

const SPARK_UTK_TAG = 'Spark-RGB-UTK-v1';
const TAPROOT_TWEAK_TAG = 'TapTweak';

const enc = new TextEncoder();

// BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data)
function taggedHash(tag, data) {
  const tagHash = sha256(enc.encode(tag));
  return sha256(concatBytes(tagHash, tagHash, data));
}

function bytesToBigInt(bytes) {
  return BigInt('0x' + bytesToHex(bytes));
}

function deriveSparkUtk(uBaseBytes, mBytes, operatorBytes) {
  // 1. t = tagged_hash("Spark-RGB-UTK-v1", U_base || m)
  const tBytes = taggedHash(SPARK_UTK_TAG, concatBytes(uBaseBytes, mBytes));
  const tScalar = bytesToBigInt(tBytes);

  // 2. U_tweaked = U_base + t·G
  const Ubase = secp.ProjectivePoint.fromHex(bytesToHex(uBaseBytes));
  const tG = secp.ProjectivePoint.BASE.multiply(tScalar);
  const Utweaked = Ubase.add(tG);
  const UtweakedBytes = Utweaked.toRawBytes(true);

  // 3. V = U_tweaked + operator_pubkey  (additive, models FROST aggregation)
  const Op = secp.ProjectivePoint.fromHex(bytesToHex(operatorBytes));
  const V = Utweaked.add(Op);
  const Vbytes = V.toRawBytes(true);

  // 4. BIP-341 noscript tweak.
  //    The internal key is taken in its even-Y representation (lift_x).
  //    output = lift_x(V_xonly) + tagged_hash("TapTweak", V_xonly) · G
  const VxonlyBytes = Vbytes.slice(1, 33);
  const VliftedBytes = concatBytes(new Uint8Array([0x02]), VxonlyBytes);
  const Vlifted = secp.ProjectivePoint.fromHex(bytesToHex(VliftedBytes));
  const tapTweakBytes = taggedHash(TAPROOT_TWEAK_TAG, VxonlyBytes);
  const tapTweakScalar = bytesToBigInt(tapTweakBytes);
  const tapG = secp.ProjectivePoint.BASE.multiply(tapTweakScalar);
  const outputPoint = Vlifted.add(tapG);
  const outputXonlyBytes = outputPoint.toRawBytes(true).slice(1, 33);

  return {
    uTweaked: bytesToHex(UtweakedBytes),
    verifyingKey: bytesToHex(Vbytes),
    outputXonly: bytesToHex(outputXonlyBytes),
  };
}

// ---- Deterministic test vector (mirrors the Rust prototype) ----

const uBaseSk = new Uint8Array(32).fill(0x11);
const operatorSk = new Uint8Array(32).fill(0x22);
const m = new Uint8Array(32).fill(0x33);

const uBase = secp.getPublicKey(uBaseSk, true);     // 33-byte compressed
const operator = secp.getPublicKey(operatorSk, true);

const out = deriveSparkUtk(uBase, m, operator);

// Pinned Rust outputs from ../03-test-vectors.md
const expected = {
  uTweaked: '02590567584842f153cc63e4ec8447e543900ff8c26f15f21a51e1996fb8a1e6e8',
  verifyingKey: '02d4632ae349ef45b121f35e9bc414efd4fdbc9ecf58e1cbe084ccf8469226853c',
  outputXonly: '5bd9be289c4d4949ea85169a2c5e905d0778fdc50bba06e47dcb3311b7792e50',
};

function row(label, actual, want) {
  const ok = actual === want;
  return `  ${ok ? '✓' : '✗'}  ${label.padEnd(15)} ${actual}${ok ? '' : `\n     expected: ${want}`}`;
}

console.log('Spark-UTK — TS reproduction\n');
console.log('Inputs:');
console.log(`  u_base       = ${bytesToHex(uBase)}`);
console.log(`  operator     = ${bytesToHex(operator)}`);
console.log(`  m            = ${bytesToHex(m)}`);
console.log('\nOutputs (TS) vs. expected (Rust):');
console.log(row('u_tweaked', out.uTweaked, expected.uTweaked));
console.log(row('verifying_key', out.verifyingKey, expected.verifyingKey));
console.log(row('output_xonly', out.outputXonly, expected.outputXonly));

const allMatch =
  out.uTweaked === expected.uTweaked &&
  out.verifyingKey === expected.verifyingKey &&
  out.outputXonly === expected.outputXonly;

console.log('');
if (allMatch) {
  console.log('MATCH — construction is portable Rust ↔ TS (byte-for-byte).');
  process.exit(0);
} else {
  console.log('MISMATCH — divergence above. Investigate before continuing.');
  process.exit(1);
}
