// Sign-in flows shared by the account and admin pages. Only the session token is kept on the device.
import { api, ApiError } from './api.js';
import { createPasskey, usePasskey } from './webauthn.js';

function remember(storage, { user, session }) {
  return storage.saveAccount({ token: session.token, expiresAt: session.expiresAt, userId: user.id });
}

// Returns { token, user } for a valid session, or null. A rejected session is forgotten.
export async function currentUser(storage) {
  const account = await storage.getAccount();
  if (!account) return null;
  try {
    const { user } = await api.me(account.token);
    return { token: account.token, user };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      await storage.clearAccount();
      return null;
    }
    throw error;
  }
}

export async function signUpWithPasskey(storage, turnstileToken) {
  const { challengeId, options } = await api.registerOptions(turnstileToken);
  const result = await api.registerVerify(challengeId, await createPasskey(options));
  await remember(storage, result);
  return result;
}

export async function signUpWithCode(storage, turnstileToken) {
  const result = await api.registerCodeOnly(turnstileToken);
  await remember(storage, result);
  return result;
}

export async function signInWithPasskey(storage) {
  const { challengeId, options } = await api.loginOptions();
  const result = await api.loginVerify(challengeId, await usePasskey(options));
  await remember(storage, result);
  return result;
}

export async function recoverWithCode(storage, code, turnstileToken) {
  const result = await api.recover(code, turnstileToken);
  await remember(storage, result);
  return result;
}

export async function addPasskey(token) {
  const { challengeId, options } = await api.passkeyOptions(token);
  return api.passkeyVerify(token, challengeId, await createPasskey(options));
}

export async function signOut(storage) {
  const account = await storage.getAccount();
  await storage.clearAccount();
  if (account) await api.logout(account.token).catch(() => {});
}
