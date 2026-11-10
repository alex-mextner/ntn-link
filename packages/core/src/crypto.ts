/**
 * Small Web Crypto helpers (available on Node, Bun and the edge runtime).
 */

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

/** Constant-time comparison of two equal-purpose strings (hex digests here). */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** 256-bit random value as base64url (43 chars). */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

const NONCE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform random string over [a-z0-9] using rejection sampling (no modulo bias). */
export function randomNonceChars(length: number): string {
  const limit = 256 - (256 % NONCE_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const buffer = new Uint8Array(length * 2);
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte < limit && out.length < length) out += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
    }
  }
  return out;
}
