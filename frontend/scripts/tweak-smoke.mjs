// Spark-UTK private-key tweak — Node smoke.
//
// Anchors the JS tweak math against the pinned Rust vector v1 from
// `scoping/03-test-vectors.md`. Mirrors the function exported by
// `src/lib/rgbAwareSigner.ts`; this script intentionally re-implements it
// in isolation so the smoke runs without instantiating any Spark SDK / WASM.
//
// Property under test:
//   pubkey((priv + tagged_hash("Spark-RGB-UTK-v1", pubkey(priv) ‖ msg)) mod n)
//   == U_tweaked from the Rust vector
//
// Run:  node frontend/scripts/tweak-smoke.mjs

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';

const SPARK_UTK_TAG = 'Spark-RGB-UTK-v1';
const enc = new TextEncoder();

function taggedHash(tag, data) {
  const tagHash = sha256(enc.encode(tag));
  const buf = new Uint8Array(tagHash.length * 2 + data.length);
  buf.set(tagHash, 0);
  buf.set(tagHash, tagHash.length);
  buf.set(data, tagHash.length * 2);
  return sha256(buf);
}

function bytesToBigInt(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function bigIntToBytes32(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function hex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function tweakPrivateKey(basePriv, msg) {
  const uBase = secp256k1.getPublicKey(basePriv, true);
  const hashInput = new Uint8Array(uBase.length + msg.length);
  hashInput.set(uBase, 0);
  hashInput.set(msg, uBase.length);
  const tBytes = taggedHash(SPARK_UTK_TAG, hashInput);
  const n = secp256k1.CURVE.n;
  const t = bytesToBigInt(tBytes) % n;
  const priv = bytesToBigInt(basePriv);
  const tweaked = (priv + t) % n;
  if (tweaked === 0n) throw new Error('zero scalar');
  return bigIntToBytes32(tweaked);
}

// ---- Vector v1, pinned in scoping/03-test-vectors.md ----------------------

const uBaseSk = new Uint8Array(32).fill(0x11);
const msg = new Uint8Array(32).fill(0x33);

const expected = {
  uBase: '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
  uTweaked: '02590567584842f153cc63e4ec8447e543900ff8c26f15f21a51e1996fb8a1e6e8',
};

const uBaseDerived = hex(secp256k1.getPublicKey(uBaseSk, true));
const privTweaked = tweakPrivateKey(uBaseSk, msg);
const uTweakedDerived = hex(secp256k1.getPublicKey(privTweaked, true));

function row(label, actual, want) {
  const ok = actual === want;
  return `  ${ok ? 'OK ' : 'FAIL'}  ${label.padEnd(13)} ${actual}${ok ? '' : `\n          expected: ${want}`}`;
}

console.log('Spark-UTK private-key tweak — Node smoke\n');
console.log('Inputs:');
console.log(`  u_base_sk    = ${hex(uBaseSk)}`);
console.log(`  msg          = ${hex(msg)}`);
console.log('\nOutputs:');
console.log(row('u_base', uBaseDerived, expected.uBase));
console.log(row('u_tweaked', uTweakedDerived, expected.uTweaked));
console.log(`  --   priv_tweaked = ${hex(privTweaked)}`);

const ok = uBaseDerived === expected.uBase && uTweakedDerived === expected.uTweaked;
console.log('');
if (ok) {
  console.log('MATCH — pubkey(priv_tweaked) == U_tweaked (Rust vector v1, byte-for-byte).');
  process.exit(0);
} else {
  console.log('MISMATCH — investigate before wiring tweak into a real transfer.');
  process.exit(1);
}
