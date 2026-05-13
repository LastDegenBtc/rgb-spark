// Envelope signing for Consignment Lab v4 (step 9d).
//
// Sender signs a canonical serialization of the envelope (every field except
// senderSignature itself) with their Nostr secret key (BIP-340 schnorr).
// Receiver re-derives the same canonical bytes, extracts the x-only pubkey
// from env.sender via nip19, and verifies the signature.
//
// Canonicalization is deterministic JSON with recursively sorted keys and no
// whitespace. This is our wire-format choice for v4 — both sender and receiver
// must agree on it byte-for-byte. Future versions can rev v if the schema
// changes; the canonicalizer is schema-agnostic.

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { nip19 } from 'nostr-tools';

export interface LeafReferenceField {
  id: string;
  treeId: string;
  value: number;
  network: string;
  verifyingPublicKey: string;
  /** Optional Spark-UTK binding metadata (chunk-α onwards). The
   *  canonicalizer drops `undefined` fields, so optionality is preserved
   *  through the signature step. */
  msgHex?: string;
  consignmentHex?: string;
  transitionHex?: string;
  prevGenesisHex?: string;
  /** Optional intermediate transition for depth-3 chains
   *  (genesis → prev_transition → transition). Used by settlement-
   *  consignment envelopes when the seller's bound leaf was already a
   *  T_1 over genesis and we emit T_2 over T_1 (Phase 1C/clean session 5.2).
   *  Buyer-side dispatch: if present, validate via
   *  `validateNiaTransitionFromPrev(transitionHex, prevTransitionHex,
   *  prevGenesisHex)`; otherwise fall back to the existing two-input
   *  `validateNiaTransition(transitionHex, prevGenesisHex)` path. */
  prevTransitionHex?: string;
  /** Output index within `transitionHex` that's assigned to the buyer
   *  (Phase 1C/clean session 7.3). Absent or 0 = single-output
   *  transitions (legacy single-recipient transfers). For partial-fill
   *  swaps, the seller emits a 2-output T_new where output 0 is the
   *  buyer's share and output 1 is seller-as-change; the buyer's stash
   *  records `outputs[buyerOutputIndex].amount` as their holding for
   *  this contract. */
  buyerOutputIndex?: number;
}

/** Envelope fields that participate in the signature. Excludes senderSignature. */
export interface UnsignedEnvelopeV4 {
  v: 4;
  sender: string;
  senderIdentityPubkey: string;
  createdAt: string;
  kind: string;
  proofHex: string;
  /** Optional — present when the proof is leaf-backed. */
  leafReference?: LeafReferenceField;
}

export interface SignedEnvelopeV4 extends UnsignedEnvelopeV4 {
  /** 128-hex BIP-340 schnorr signature over sha256(canonicalize(unsigned)). */
  senderSignature: string;
}

export type SignatureCheck =
  | { kind: 'ok' }
  | { kind: 'fail'; reason: string }
  | { kind: 'missing' }; // pre-v4 envelopes

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Deterministic JSON: keys recursively sorted, no whitespace, JSON.stringify
 * for primitives. Numbers go through JSON.stringify so NaN/Infinity throw on
 * the way out (good — they have no canonical form here).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`canonicalize: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
      '}'
    );
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
}

function digest(unsigned: UnsignedEnvelopeV4): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalize(unsigned));
  return sha256(bytes);
}

export function signEnvelope(
  unsigned: UnsignedEnvelopeV4,
  privkeyHex: string,
): string {
  const msg = digest(unsigned);
  const priv = hexToBytes(privkeyHex);
  if (priv.length !== 32) throw new Error('privkey must be 32 bytes');
  const sig = schnorr.sign(msg, priv);
  return bytesToHex(sig);
}

export function verifyEnvelope(signed: SignedEnvelopeV4): SignatureCheck {
  try {
    const { senderSignature, ...rest } = signed;
    if (!senderSignature || senderSignature.length !== 128) {
      return { kind: 'fail', reason: 'senderSignature must be 64 bytes (128 hex)' };
    }
    const decoded = nip19.decode(signed.sender);
    if (decoded.type !== 'npub') {
      return { kind: 'fail', reason: `sender is not an npub (got ${decoded.type})` };
    }
    const pubkeyHex = decoded.data as string;
    const msg = digest(rest as UnsignedEnvelopeV4);
    const ok = schnorr.verify(senderSignature, msg, pubkeyHex);
    return ok
      ? { kind: 'ok' }
      : { kind: 'fail', reason: 'schnorr.verify returned false' };
  } catch (e) {
    return { kind: 'fail', reason: e instanceof Error ? e.message : String(e) };
  }
}
