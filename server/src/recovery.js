import { randomBytes, hmacHex } from './crypto.js';
import { HttpError } from './http.js';

// Crockford base32: no I, L, O, U, so a code read aloud or retyped is hard to confuse.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 20; // 20 × 5 bits = 100 bits: guessing is hopeless even without rate limits.

export function generateRecoveryCode() {
  // 256 is divisible by 32, so `byte & 31` is uniform.
  return [...randomBytes(CODE_LENGTH)].map((byte) => ALPHABET[byte & 31]).join('');
}

export function formatRecoveryCode(code) {
  return code.match(/.{1,5}/g).join('-');
}

// Returns the canonical 20-symbol code, or null if the input cannot be a code.
export function normalizeRecoveryCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (code.length !== CODE_LENGTH || [...code].some((ch) => !ALPHABET.includes(ch))) return null;
  return code;
}

export function recoveryHmac(env, code) {
  if (!env.RECOVERY_PEPPER) throw new HttpError(503, 'unconfigured', 'Сервер не настроен: нет секрета для кодов восстановления.');
  return hmacHex(env.RECOVERY_PEPPER, code);
}
