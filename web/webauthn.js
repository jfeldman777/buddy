// Passkeys in the browser: converts the server's JSON options to WebAuthn calls and the results back to JSON.

export function toBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const withIds = (list) => (list ?? []).map((item) => ({ ...item, id: fromBase64Url(item.id) }));

export function creationOptions(json) {
  return {
    ...json,
    challenge: fromBase64Url(json.challenge),
    user: { ...json.user, id: fromBase64Url(json.user.id) },
    excludeCredentials: withIds(json.excludeCredentials),
  };
}

export function requestOptions(json) {
  return { ...json, challenge: fromBase64Url(json.challenge), allowCredentials: withIds(json.allowCredentials) };
}

export function registrationJson(credential) {
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

export function authenticationJson(credential) {
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined,
    },
  };
}

export function passkeysSupported() {
  return Boolean(globalThis.PublicKeyCredential && navigator.credentials?.create);
}

export class PasskeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function passkeyError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return new PasskeyError('cancelled', 'Passkey не подтверждён: вы отменили запрос или время вышло.');
  }
  if (error?.name === 'InvalidStateError') {
    return new PasskeyError('exists', 'На этом устройстве уже есть passkey для этой учётной записи.');
  }
  if (error?.name === 'SecurityError') {
    return new PasskeyError('security', 'Браузер не разрешил passkey для этого адреса.');
  }
  return new PasskeyError('failed', 'Не получилось использовать passkey на этом устройстве.');
}

export async function createPasskey(optionsJson) {
  try {
    return registrationJson(await navigator.credentials.create({ publicKey: creationOptions(optionsJson) }));
  } catch (error) {
    throw passkeyError(error);
  }
}

export async function usePasskey(optionsJson) {
  try {
    return authenticationJson(await navigator.credentials.get({ publicKey: requestOptions(optionsJson) }));
  } catch (error) {
    throw passkeyError(error);
  }
}
