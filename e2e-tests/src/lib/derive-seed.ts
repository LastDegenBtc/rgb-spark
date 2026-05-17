// Deterministic derivation of per-test seeds from a single master.
//
// The funding wallet's seed (in .env) is the root of trust. Each test
// scenario derives sub-seeds via HMAC-SHA256(master, scenarioLabel),
// so a given (master, label) pair always produces the same wallet
// across runs. This lets a scenario re-run idempotently — a wallet
// minted on a prior run is still reachable by re-deriving its seed.
//
// Why not BIP-32 hardened paths: simpler, doesn't add a runtime dep,
// and matches how the sprk-fun frontend already treats the seed as
// a flat 32-byte secret (cf. nostrKey.ts). The hashed-label gives us
// derivation properties without committing to a path scheme.

import { createHmac } from 'node:crypto'

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex must have even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

/** Derive a 32-byte sub-seed from the master. Pure function:
 *  the same (masterSeedHex, label) always yields the same sub-seed. */
export function deriveSubSeedHex(masterSeedHex: string, label: string): string {
  const master = hexToBytes(masterSeedHex)
  const labelBytes = new TextEncoder().encode(label)
  const out = createHmac('sha256', master).update(labelBytes).digest()
  return bytesToHex(new Uint8Array(out))
}
