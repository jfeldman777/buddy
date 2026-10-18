// The only module that talks to the Buddy server.
// Auth: passkey, recovery, Turnstile. Buddy-011: consented chat/memory (never the local journal store).
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
    /** Buddy-018: read a Notion teaching page (admin elevated session). Default = first chapter. */
    adminNotionPage: (token, { id, url } = {}) => {
      const q = new URLSearchParams();
      if (id) q.set('id', id);
      if (url) q.set('url', url);
      const qs = q.toString();
      return call('GET', `/admin/notion/page${qs ? `?${qs}` : ''}`, { token });
    },
    /** Buddy-018 step 5: teach cycle for allowed fragment (elevated admin). */
    adminTeachRun: (token, fragmentId) => call('POST', '/admin/teach/run', {
      token,
      body: { fragmentId },
    }),
    adminTeachFragments: (token) => call('GET', '/admin/teach/fragments', { token }),
    adminTeachChainStart: (token, body = {}) => call('POST', '/admin/teach/chain/start', { token, body }),
    adminTeachChainContinue: (token, runId) => call('POST', '/admin/teach/chain/continue', {
      token,
      body: { runId },
    }),
    adminTeachChainGet: (token, id) => call(
      'GET',
      `/admin/teach/chain?id=${encodeURIComponent(id)}`,
      { token },
    ),
    adminTeachChains: (token) => call('GET', '/admin/teach/chains', { token }),
    /** Step 8A: Creator↔Bi teaching session. */
    adminTeachSessionStart: (token, body = {}) => call('POST', '/admin/teach/session/start', { token, body }),
    adminTeachSessionIngest: (token, sessionId) => call('POST', '/admin/teach/session/ingest', {
      token,
      body: { sessionId },
    }),
    adminTeachSessionTurn: (token, sessionId, text) => call('POST', '/admin/teach/session/turn', {
      token,
      body: { sessionId, text },
    }),
    adminTeachSessionGet: (token, id) => call(
      'GET',
      `/admin/teach/session?id=${encodeURIComponent(id)}`,
      { token },
    ),
    adminTeachSessions: (token) => call('GET', '/admin/teach/sessions', { token }),
    adminTeachSessionClose: (token, sessionId) => call('POST', '/admin/teach/session/close', {
      token,
      body: { sessionId },
    }),
    /** Step 6: open dispute (also step-5 /ruling alias). */
    adminTeachDispute: (token, body) => call('POST', '/admin/teach/dispute', { token, body }),
    adminTeachDisputes: (token, { fragmentId, status } = {}) => {
      const q = new URLSearchParams();
      if (fragmentId) q.set('fragmentId', fragmentId);
      if (status) q.set('status', status);
      const qs = q.toString();
      return call('GET', `/admin/teach/disputes${qs ? `?${qs}` : ''}`, { token });
    },
    adminTeachDisputeGet: (token, id) => call(
      'GET',
      `/admin/teach/dispute?id=${encodeURIComponent(id)}`,
      { token },
    ),
    adminTeachDisputeMessage: (token, body) => call('POST', '/admin/teach/dispute/message', { token, body }),
    adminTeachDisputeDiscuss: (token, body) => call('POST', '/admin/teach/dispute/discuss', { token, body }),
    adminTeachDisputeResolve: (token, body) => call('POST', '/admin/teach/dispute/resolve', { token, body }),
    /** @deprecated use adminTeachDispute */
    adminTeachRuling: (token, body) => call('POST', '/admin/teach/ruling', { token, body }),
    adminTeachRulings: (token, fragmentId) => call(
      'GET',
      `/admin/teach/rulings?fragmentId=${encodeURIComponent(fragmentId)}`,
      { token },
    ),
    dcbBudget: (token) => call('GET', '/dcb/budget', { token }),
    dcbPersonas: (token) => call('GET', '/dcb/personas', { token }),
    dcbCreatePersona: (token, body) => call('POST', '/dcb/personas', { token, body }),
    dcbGetPersona: (token, id) => call('GET', `/dcb/personas/${id}`, { token }),
    dcbPatchPersona: (token, id, body) => call('PATCH', `/dcb/personas/${id}`, { token, body }),
    dcbDeletePersona: (token, id) => call('DELETE', `/dcb/personas/${id}`, { token }),
    dcbSessions: (token) => call('GET', '/dcb/sessions', { token }),
    dcbCreateSession: (token, body) => call('POST', '/dcb/sessions', { token, body }),
    dcbGetSession: (token, id) => call('GET', `/dcb/sessions/${id}`, { token }),
    dcbDeleteSession: (token, id) => call('DELETE', `/dcb/sessions/${id}`, { token }),
    dcbPause: (token, id) => call('POST', `/dcb/sessions/${id}/pause`, { token, body: {} }),
    dcbResume: (token, id) => call('POST', `/dcb/sessions/${id}/resume`, { token, body: {} }),
    dcbFinish: (token, id) => call('POST', `/dcb/sessions/${id}/finish`, { token, body: {} }),
    dcbPromote: (token, id) => call('POST', `/dcb/sessions/${id}/promote`, { token, body: {} }),
    dcbAddPhoto: (token, id, body) => call('POST', `/dcb/sessions/${id}/photos`, { token, body }),
    dcbBi: (token, id) => call('POST', `/dcb/sessions/${id}/bi`, { token, body: {} }),
    dcbSi: (token, id) => call('POST', `/dcb/sessions/${id}/si`, { token, body: {} }),
    dcbReview: (token, id, body) => call('POST', `/dcb/sessions/${id}/review`, { token, body }),
    dcbIdeas: (token, id, body) => call('POST', `/dcb/sessions/${id}/ideas`, { token, body }),
    dcbExport: (token, id) => call('GET', `/dcb/sessions/${id}/export`, { token }),
    chatConsent: (token) => call('GET', '/chat/consent', { token }),
    chatGiveConsent: (token, body) => call('POST', '/chat/consent', { token, body }),
    chatBudget: (token) => call('GET', '/chat/budget', { token }),
    chatContext: (token) => call('GET', '/chat/context', { token }),
    chatTurn: (token, body) => call('POST', '/chat/turn', { token, body }),
  };
}

export const api = createApi(API_BASE);
