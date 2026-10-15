// The only module that talks to the Buddy server. It sends sign-in data only:
// passkey responses, recovery codes and Turnstile tokens. Names, conversations and the journal never go here.
import { API_BASE } from './config.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApi(base, fetchImpl = (...args) => fetch(...args)) {
  async function call(method, path, { body, token } = {}) {
    if (!base) throw new ApiError(0, 'not_configured', 'Сервер Buddy ещё не подключён.');
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(0, 'offline', 'Нет связи с сервером Buddy. Проверьте интернет и попробуйте ещё раз.');
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, data.error ?? 'http_error', data.message ?? `Ошибка сервера ${response.status}.`);
    return data;
  }

  return {
    configured: Boolean(base),
    health: () => call('GET', '/health'),
    registerOptions: (turnstileToken) => call('POST', '/auth/register/options', { body: { turnstileToken } }),
    registerVerify: (challengeId, response) => call('POST', '/auth/register/verify', { body: { challengeId, response } }),
    registerCodeOnly: (turnstileToken) => call('POST', '/auth/register/code-only', { body: { turnstileToken } }),
    loginOptions: () => call('POST', '/auth/login/options', { body: {} }),
    loginVerify: (challengeId, response) => call('POST', '/auth/login/verify', { body: { challengeId, response } }),
    recover: (code, turnstileToken) => call('POST', '/auth/recover', { body: { code, turnstileToken } }),
    logout: (token) => call('POST', '/auth/logout', { token }),
    me: (token) => call('GET', '/me', { token }),
    passkeyOptions: (token) => call('POST', '/me/passkeys/options', { token, body: {} }),
    passkeyVerify: (token, challengeId, response) => call('POST', '/me/passkeys/verify', { token, body: { challengeId, response } }),
    newRecoveryCode: (token) => call('POST', '/me/recovery-code', { token, body: {} }),
    adminUsers: (token) => call('GET', '/admin/users', { token }),
  };
}

export const api = createApi(API_BASE);
