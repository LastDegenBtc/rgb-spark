// Asset metadata storage (Phase 1C/clean session 11).
//
// Signed off-chain metadata blob — ticker / name / logo / description /
// socials — attached to a contractId. Cryptographic identity stays the
// contractId (extracted from genesis bytes); this is purely
// "human-readable layer" content.
//
// Trust posture:
// - Metadata is signed by the issuer's nsec (BIP-340 schnorr).
// - The issuer is identified by the npub that posted the FIRST order
//   on this contractId (= registered the asset). Subsequent posters
//   cannot rewrite metadata.
// - A relay can refuse to serve a blob it dislikes, but it cannot
//   forge a signed blob — verification happens server-side at POST.
//
// Persistence: in-memory only — restart wipes. Persistent metadata is
// a v1+ concern; the issuer can simply re-post.

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { nip19 } from 'nostr-tools'
import { canonicalize } from './orderbook.js'
import { getAssetStats } from './registry.js'

// Wire constraints — caps deliberately conservative for v0.
const MAX_TICKER_LEN = 16
const MAX_NAME_LEN = 64
const MAX_DESCRIPTION_LEN = 1024
const MAX_IMAGE_URL_LEN = 512
const MAX_SOCIAL_VALUE_LEN = 128
const MAX_SOCIAL_KEYS = 8
const SCHNORR_SIG_RE = /^[0-9a-f]{128}$/i

export interface AssetMetadata {
  contractId: string
  ticker: string
  name: string
  imageUrl?: string
  description?: string
  socials?: Record<string, string>
  createdAt: string
}

export interface SignedAssetMetadata extends AssetMetadata {
  /** Issuer's bech32 npub. MUST match the registry's issuerNpub for
   *  this contractId (= the first npub to ever post an order). */
  issuerNpub: string
  /** 128-hex BIP-340 schnorr signature over
   *  `sha256(canonicalize(payload))`, where payload is everything
   *  except `signature` itself. */
  signature: string
}

/**
 * Full validation — structure + signature + issuer-binding. Returns
 * null on success, an error message on failure.
 */
export function validateMetadata(m: SignedAssetMetadata, expectedContractId: string): string | null {
  if (!m || typeof m !== 'object') return 'not an object'
  if (typeof m.contractId !== 'string' || !/^[0-9a-f]{64}$/i.test(m.contractId)) {
    return 'bad contractId'
  }
  if (m.contractId.toLowerCase() !== expectedContractId.toLowerCase()) {
    return `contractId mismatch: payload ${m.contractId} vs path ${expectedContractId}`
  }
  if (typeof m.ticker !== 'string' || m.ticker.length === 0 || m.ticker.length > MAX_TICKER_LEN) {
    return `bad ticker (1..${MAX_TICKER_LEN} chars)`
  }
  if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > MAX_NAME_LEN) {
    return `bad name (1..${MAX_NAME_LEN} chars)`
  }
  if (m.imageUrl !== undefined) {
    if (typeof m.imageUrl !== 'string' || m.imageUrl.length > MAX_IMAGE_URL_LEN) {
      return `bad imageUrl (max ${MAX_IMAGE_URL_LEN} chars)`
    }
    if (!/^https?:\/\//i.test(m.imageUrl)) return 'imageUrl must be http(s)'
  }
  if (m.description !== undefined) {
    if (typeof m.description !== 'string' || m.description.length > MAX_DESCRIPTION_LEN) {
      return `bad description (max ${MAX_DESCRIPTION_LEN} chars)`
    }
  }
  if (m.socials !== undefined) {
    if (typeof m.socials !== 'object' || m.socials === null) return 'socials must be object'
    const keys = Object.keys(m.socials)
    if (keys.length > MAX_SOCIAL_KEYS) return `too many socials (max ${MAX_SOCIAL_KEYS})`
    for (const k of keys) {
      const v = m.socials[k]
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SOCIAL_VALUE_LEN) {
        return `bad socials[${k}] (1..${MAX_SOCIAL_VALUE_LEN} chars)`
      }
    }
  }
  if (typeof m.createdAt !== 'string' || isNaN(Date.parse(m.createdAt))) {
    return 'bad createdAt'
  }
  if (typeof m.issuerNpub !== 'string') return 'bad issuerNpub'
  if (typeof m.signature !== 'string' || !SCHNORR_SIG_RE.test(m.signature)) {
    return 'bad signature (128-hex)'
  }

  // Decode the npub to its x-only pubkey for verify.
  let xonly: string
  try {
    const decoded = nip19.decode(m.issuerNpub)
    if (decoded.type !== 'npub') return `issuerNpub is not an npub (got ${decoded.type})`
    xonly = decoded.data as string
  } catch (e) {
    return `issuerNpub decode failed: ${(e as Error).message}`
  }

  // Issuer-binding: registry must already have this contractId AND
  // its issuerNpub must equal what's claimed in the metadata.
  const stats = getAssetStats(m.contractId)
  if (!stats) return 'contractId not in registry (post an order for it first)'
  if (!stats.issuerNpub) return 'registry has no issuerNpub for this contractId'
  if (stats.issuerNpub !== m.issuerNpub) {
    return `issuerNpub mismatch: claimed ${m.issuerNpub.slice(0, 10)}… vs registry ${stats.issuerNpub.slice(0, 10)}…`
  }

  // Signature: sha256 of the canonicalized payload (without signature
  // itself). Same canonicalizer as the orderbook so a single client
  // implementation works for both.
  const { signature, ...payload } = m
  const canonical = canonicalize(payload)
  const msg = sha256(new TextEncoder().encode(canonical))
  const sigBytes = hexToBytes(signature)
  const pubkeyBytes = hexToBytes(xonly)
  let ok: boolean
  try {
    ok = schnorr.verify(sigBytes, msg, pubkeyBytes)
  } catch (e) {
    return `schnorr.verify threw: ${(e as Error).message}`
  }
  if (!ok) return 'schnorr signature verify returned false'
  return null
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// ----- Store -----------------------------------------------------------

const MAX_METADATA_ENTRIES = 10_000
const store = new Map<string, SignedAssetMetadata>()

/**
 * Upsert metadata for a contractId. Latest signed version wins
 * (assuming `validateMetadata` passed). Throws with `http` on
 * recoverable errors.
 */
export function putMetadata(contractId: string, signed: SignedAssetMetadata): void {
  const err = validateMetadata(signed, contractId)
  if (err) throw Object.assign(new Error(`bad metadata: ${err}`), { http: 400 })
  const key = contractId.toLowerCase()
  if (!store.has(key) && store.size >= MAX_METADATA_ENTRIES) {
    throw Object.assign(new Error('metadata store full'), { http: 507 })
  }
  store.set(key, signed)
}

export function getMetadata(contractId: string): SignedAssetMetadata | null {
  return store.get(contractId.toLowerCase()) ?? null
}

export function metadataHealth(): { assetsWithMetadata: number } {
  return { assetsWithMetadata: store.size }
}
