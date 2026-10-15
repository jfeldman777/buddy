import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { randomBytes, toBase64Url, fromBase64Url } from './crypto.js';
import { HttpError, allowedOrigins, now } from './http.js';

const CHALLENGE_MS = 5 * 60 * 1000;
// EdDSA, ES256, RS256 — what phones and password managers actually use.
const ALGORITHMS = [-8, -7, -257];
const encoder = new TextEncoder();

export async function saveChallenge(env, { purpose, challenge, userId = null }) {
  const id = toBase64Url(randomBytes(16));
  await env.DB.prepare('INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, challenge, purpose, userId, now(env) + CHALLENGE_MS).run();
  return id;
}

// A challenge works once: it is deleted in the same statement that reads it.
export async function takeChallenge(env, id, purpose) {
  const row = typeof id === 'string' && id.length <= 64
    ? await env.DB.prepare('DELETE FROM challenges WHERE id = ?1 AND purpose = ?2 RETURNING challenge, user_id, expires_at').bind(id, purpose).first()
    : null;
  if (!row || row.expires_at <= now(env)) throw new HttpError(400, 'challenge_expired', 'Запрос устарел. Попробуйте ещё раз.');
  return row;
}

export function registrationOptions(env, userId, existing = []) {
  return generateRegistrationOptions({
    rpName: env.RP_NAME ?? 'Buddy',
    rpID: env.RP_ID,
    userName: `buddy-${userId.slice(0, 8)}`,
    userDisplayName: 'Buddy',
    userID: encoder.encode(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

export async function verifyRegistration(env, response, expectedChallenge) {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: allowedOrigins(env),
      expectedRPID: env.RP_ID,
      requireUserVerification: false,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch {
    verification = { verified: false };
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid', 'Passkey не прошёл проверку.');
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  return {
    id: credential.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports?.length ? JSON.stringify(credential.transports) : null,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp ? 1 : 0,
  };
}

export function insertCredential(env, userId, credential) {
  return env.DB.prepare(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(credential.id, userId, credential.publicKey, credential.counter, credential.transports, credential.deviceType, credential.backedUp, new Date(now(env)).toISOString());
}

export function authenticationOptions(env) {
  return generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: 'preferred' });
}

// Returns the stored credential row and whether the person was verified (PIN, fingerprint, face).
export async function verifyAuthentication(env, response, expectedChallenge) {
  const id = typeof response?.id === 'string' && response.id.length <= 1024 ? response.id : null;
  const stored = id && await env.DB.prepare(
    `SELECT c.id, c.user_id, c.public_key, c.counter, c.transports, u.role, u.status
     FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ?1`,
  ).bind(id).first();
  if (!stored) throw new HttpError(400, 'passkey_unknown', 'Этот passkey не найден. Возможно, учётная запись была создана на другом сайте или удалена.');

  const userHandle = response.response?.userHandle;
  if (userHandle && new TextDecoder().decode(fromBase64Url(userHandle)) !== stored.user_id) {
    throw new HttpError(400, 'passkey_invalid', 'Passkey не прошёл проверку.');
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: allowedOrigins(env),
      expectedRPID: env.RP_ID,
      credential: {
        id: stored.id,
        publicKey: fromBase64Url(stored.public_key),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
      requireUserVerification: false,
    });
  } catch {
    verification = { verified: false };
  }
  if (!verification.verified) throw new HttpError(400, 'passkey_invalid', 'Passkey не прошёл проверку.');
  if (stored.status !== 'active') throw new HttpError(403, 'blocked', 'Учётная запись заблокирована.');

  await env.DB.prepare('UPDATE credentials SET counter = ?1, last_used_at = ?2 WHERE id = ?3')
    .bind(verification.authenticationInfo.newCounter, new Date(now(env)).toISOString(), stored.id).run();
  return { stored, userVerified: verification.authenticationInfo.userVerified };
}
