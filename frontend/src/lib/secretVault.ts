// PIN-encrypted vault for the user's mnemonic / nsec, stored in localStorage.
//
// Why localStorage: this is the persistence layer that survives a tab close /
// browser restart. Sensitive content goes through PBKDF2 + AES-GCM, so the
// raw secret is never readable without the PIN — even by an attacker with
// localStorage read access (XSS, compromised dep, browser extension).
//
// Why PBKDF2 vs Argon2: PBKDF2 is built into Web Crypto with no extra deps.
// Argon2 is stronger memory-hard but needs a ~100KB WASM blob for the same
// browser support. 600k iterations PBKDF2-SHA256 is the OWASP 2023 baseline
// for password-based key derivation; takes ~300ms on a phone, fine for unlock.

const VAULT_KEY = 'spark_rgb_vault_v1';
const PBKDF2_ITERATIONS = 600_000;
const AES_KEY_BITS = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedVault {
  v: 1;
  iter: number;
  salt: string; // base64
  iv: string;   // base64
  ct: string;   // base64
  /** First 8 chars of the npub the vault was set for. Used to detect when
   *  the user has switched wallets and the vault is stale. */
  npubFp?: string;
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// crypto.subtle accepts BufferSource; passing a fresh Uint8Array() copy
// avoids the Uint8Array<ArrayBufferLike> typing snag from new TS lib defs.
function bs(u: Uint8Array): ArrayBuffer {
  return new Uint8Array(u).buffer as ArrayBuffer;
}

async function deriveKey(pin: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    bs(new TextEncoder().encode(pin)),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(salt), iterations: iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecret(secret: string, pin: string, npub: string): Promise<EncryptedVault> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(pin, salt, PBKDF2_ITERATIONS);
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv) },
    key,
    bs(new TextEncoder().encode(secret)),
  );
  return {
    v: 1,
    iter: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
    npubFp: npub.slice(0, 8),
  };
}

export class WrongPinError extends Error {
  override readonly name = 'WrongPinError';
}

export async function decryptSecret(vault: EncryptedVault, pin: string): Promise<string> {
  const salt = base64ToBytes(vault.salt);
  const iv = base64ToBytes(vault.iv);
  const ct = base64ToBytes(vault.ct);
  const key = await deriveKey(pin, salt, vault.iter);
  try {
    const ptBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(iv) },
      key,
      bs(ct),
    );
    return new TextDecoder().decode(ptBuf);
  } catch {
    // AES-GCM throws on tag mismatch — that's how we detect a wrong PIN.
    throw new WrongPinError('Wrong PIN');
  }
}

export function readVault(): EncryptedVault | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EncryptedVault;
    if (parsed && parsed.v === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeVault(vault: EncryptedVault): void {
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

export function clearVault(): void {
  localStorage.removeItem(VAULT_KEY);
}

export function hasVault(): boolean {
  return readVault() !== null;
}
