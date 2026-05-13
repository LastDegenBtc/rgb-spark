// Typed client for the rgb-spark relay's asset metadata routes
// (Phase 1C/clean session 11). Stores a signed off-chain blob
// (ticker / name / image / description / socials) per contractId.
// Wire types kept in sync with `relay/src/metadata.ts`.
//
// Identity binding: the FIRST npub to post an order for a contractId
// is captured as the asset's issuer. Only that npub can post metadata
// for it. The relay verifies a BIP-340 schnorr signature server-side
// before persisting.

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { canonicalize } from './envelopeSign';

export interface AssetMetadataPayload {
  contractId: string;
  ticker: string;
  name: string;
  imageUrl?: string;
  description?: string;
  socials?: Record<string, string>;
  createdAt: string;
  issuerNpub: string;
}

export interface SignedAssetMetadata extends AssetMetadataPayload {
  signature: string;
}

export class MetadataError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'MetadataError';
  }
}

const DEFAULT_BASE = (typeof window !== 'undefined' && window.location.hostname === 'localhost')
  ? 'http://localhost:5180'
  : '/relay';

function url(base: string | undefined, path: string): string {
  return `${base ?? DEFAULT_BASE}${path}`;
}

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
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Sign an AssetMetadataPayload with the issuer's Nostr nsec. The
 * canonicalizer is the same one the orderbook client + relay use, so
 * the byte-exact payload matches what the relay verifies against.
 */
export function signMetadata(
  payload: AssetMetadataPayload,
  nostrPrivkeyHex: string,
): SignedAssetMetadata {
  const canonical = canonicalize(payload as unknown as Record<string, unknown>);
  const digest = sha256(new TextEncoder().encode(canonical));
  const priv = hexToBytes(nostrPrivkeyHex);
  if (priv.length !== 32) throw new Error('nostrPrivkey must be 32 bytes');
  const sig = schnorr.sign(digest, priv);
  return { ...payload, signature: bytesToHex(sig) };
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      // keep statusText
    }
    throw new MetadataError(res.status, `metadata ${res.status}: ${msg}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('json')) {
    throw new MetadataError(
      res.status,
      `metadata returned non-JSON (content-type: ${ct || 'unset'}).`,
    );
  }
  return res.json();
}

export async function postMetadata(
  signed: SignedAssetMetadata,
  opts?: { baseUrl?: string },
): Promise<void> {
  const res = await fetch(url(opts?.baseUrl, `/asset/${encodeURIComponent(signed.contractId)}/metadata`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  await jsonOrThrow(res);
}

export async function fetchMetadata(
  contractId: string,
  opts?: { baseUrl?: string },
): Promise<SignedAssetMetadata | null> {
  const res = await fetch(url(opts?.baseUrl, `/asset/${encodeURIComponent(contractId)}/metadata`));
  if (res.status === 404) return null;
  return await jsonOrThrow(res) as SignedAssetMetadata;
}
