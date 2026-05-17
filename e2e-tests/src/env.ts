// Minimal .env loader. We avoid pulling `dotenv` as a dep — the format
// we accept is strict (KEY=value lines, no quoting tricks, no
// expansion). Anything more complex doesn't belong here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ENV_PATH = resolve(import.meta.dirname, '..', '.env')

export interface HarnessEnv {
  fundingSeedHex: string | null
  relayBaseUrl: string
  sparkNetwork: 'MAINNET' | 'TESTNET' | 'REGTEST'
}

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

export function loadEnv(): HarnessEnv {
  const map = existsSync(ENV_PATH) ? parseEnvFile(readFileSync(ENV_PATH, 'utf8')) : {}
  const network = (map.SPARK_NETWORK ?? 'MAINNET').toUpperCase()
  if (network !== 'MAINNET' && network !== 'TESTNET' && network !== 'REGTEST') {
    throw new Error(`SPARK_NETWORK must be MAINNET / TESTNET / REGTEST, got ${network}`)
  }
  return {
    fundingSeedHex: map.FUNDING_SEED_HEX && map.FUNDING_SEED_HEX.length > 0 ? map.FUNDING_SEED_HEX : null,
    relayBaseUrl: map.RELAY_BASE_URL ?? 'http://localhost:5180',
    sparkNetwork: network,
  }
}

/** Persist (key, value) pairs to .env, preserving any keys not in `patch`.
 *  Used by `setup` to write the freshly-generated funding seed without
 *  clobbering the user's RELAY_BASE_URL / SPARK_NETWORK overrides. */
export function patchEnv(patch: Record<string, string>): void {
  const existing = existsSync(ENV_PATH) ? parseEnvFile(readFileSync(ENV_PATH, 'utf8')) : {}
  const merged = { ...existing, ...patch }
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`)
  writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8')
}
