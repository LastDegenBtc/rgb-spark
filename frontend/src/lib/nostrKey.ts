// Identity derivation for the unified-seed login model.
//
// The Nostr private key (nsec) is the **single root** of identity in this app:
//
//   - It IS the user's identity against the trading server (npub).
//   - It IS the seed used to initialize the Spark wallet.
//
// That means a given nsec → exactly one Spark wallet + one npub, regardless of
// whether the user came in via mnemonic or via raw nsec. Mnemonic users get
// their nsec via NIP-06 (m/44'/1237'/0'/0/0) and then we feed the resulting
// privkey bytes back as the Spark seed.
//
// Why unify on nsec rather than the BIP-39 seed:
//   - Compatibility with Nostr-signing extensions (Alby, lnfi) and the prior
//     Ark site, where users only ever held an nsec — we want them to land on
//     the same npub here so server-side ARKPP balances can be reassigned.
//   - Symmetric login: nsec users and mnemonic users get the same Spark wallet
//     when their nsec matches.
//
// The cost: anything previously seeded directly from a BIP-39 mnemonic gets a
// fresh Spark wallet under this model. Acceptable for the spike.

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { nip19, getPublicKey } from 'nostr-tools';

export type LoginKind = 'mnemonic' | 'nsec';

export interface ParsedLogin {
  kind: LoginKind;
  /** Hex-encoded 32-byte Nostr secret key. Used for NIP-98 server auth. */
  nostrPrivkeyHex: string;
  /** Same 32 bytes as nostrPrivkeyHex — passed to Spark as `mnemonicOrSeed`. */
  sparkSeed: Uint8Array;
  /** bech32 npub (always present). */
  npub: string;
  /** Original mnemonic, if the user logged in with one. Undefined for nsec login. */
  mnemonic?: string;
  /** Bech32 nsec for backup display. */
  nsec: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function deriveNostrPrivkeyFromMnemonic(mnemonic: string): Uint8Array {
  const seed = mnemonicToSeedSync(mnemonic);
  const root = HDKey.fromMasterSeed(seed);
  const child = root.derive("m/44'/1237'/0'/0/0");
  if (!child.privateKey) throw new Error('NIP-06: derivation produced no private key');
  return child.privateKey;
}

function isLikelyMnemonic(s: string): boolean {
  const words = s.trim().split(/\s+/);
  return words.length === 12 || words.length === 24;
}

function isLikelyNsec(s: string): boolean {
  const t = s.trim();
  if (t.toLowerCase().startsWith('nsec1')) return true;
  if (/^[0-9a-fA-F]{64}$/.test(t)) return true;
  return false;
}

/**
 * Accepts a mnemonic (12/24 words), an nsec (`nsec1...` bech32), or a 64-hex
 * Nostr secret key. Returns everything the rest of the app needs for unlock:
 * the Spark seed bytes, the privkey hex (for server NIP-98 signing), the npub,
 * and a bech32 nsec for backup display.
 */
export function parseLoginSecret(input: string): ParsedLogin {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Empty input');

  let kind: LoginKind;
  let privkeyBytes: Uint8Array;
  let mnemonic: string | undefined;

  if (isLikelyMnemonic(trimmed)) {
    if (!validateMnemonic(trimmed, wordlist)) {
      throw new Error('Invalid mnemonic — check the word list and ordering');
    }
    kind = 'mnemonic';
    mnemonic = trimmed;
    privkeyBytes = deriveNostrPrivkeyFromMnemonic(trimmed);
  } else if (isLikelyNsec(trimmed)) {
    kind = 'nsec';
    if (trimmed.toLowerCase().startsWith('nsec1')) {
      const decoded = nip19.decode(trimmed);
      if (decoded.type !== 'nsec') throw new Error('Bech32 input was not an nsec');
      privkeyBytes = decoded.data;
    } else {
      privkeyBytes = hexToBytes(trimmed.toLowerCase());
    }
    if (privkeyBytes.length !== 32) {
      throw new Error('nsec must decode to 32 bytes');
    }
  } else {
    throw new Error('Enter a 12/24 word mnemonic or an nsec (nsec1… or 64 hex chars)');
  }

  const nostrPrivkeyHex = bytesToHex(privkeyBytes);
  const npubHex = getPublicKey(privkeyBytes);
  const npub = nip19.npubEncode(npubHex);
  const nsec = nip19.nsecEncode(privkeyBytes);

  return {
    kind,
    nostrPrivkeyHex,
    sparkSeed: privkeyBytes,
    npub,
    nsec,
    mnemonic,
  };
}
