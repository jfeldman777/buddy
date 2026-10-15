// Software passkey for tests: produces real WebAuthn responses (attestation "none", ES256),
// so the server's verification runs exactly as it would with a phone.
import { isoCBOR } from '@simplewebauthn/server/helpers';

const encoder = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const uint32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function derInteger(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let value = bytes.slice(i);
  if (value[0] & 0x80) value = concat(new Uint8Array([0]), value);
  return concat(new Uint8Array([0x02, value.length]), value);
}

function rawToDer(signature) {
  const body = concat(derInteger(signature.slice(0, 32)), derInteger(signature.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export async function createAuthenticator({ userVerified = true } = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  let userHandle = null;
  const flags = (attested) => (attested ? 0x40 : 0) | 0x01 | (userVerified ? 0x04 : 0);

  return {
    id: b64url(credentialId),

    async register(options, origin) {
      userHandle = options.user.id;
      const clientDataJSON = encoder.encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
      const cosePublicKey = isoCBOR.encode(new Map([
        [1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]));
      const authData = concat(
        await sha256(encoder.encode(options.rp.id)),
        new Uint8Array([flags(true)]),
        uint32(counter),
        new Uint8Array(16),
        new Uint8Array([0, credentialId.length]),
        credentialId,
        cosePublicKey,
      );
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ['internal'] },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    async authenticate(options, origin, { rpId = options.rpId } = {}) {
      counter += 1;
      const clientDataJSON = encoder.encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
      const authenticatorData = concat(await sha256(encoder.encode(rpId)), new Uint8Array([flags(false)]), uint32(counter));
      const signed = concat(authenticatorData, await sha256(clientDataJSON));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed));
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(rawToDer(raw)),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}
