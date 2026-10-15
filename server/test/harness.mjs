import worker from '../src/index.js';
import { createD1 } from './d1.mjs';

export const ORIGIN = 'http://localhost:8080';

// limits: { LIMIT_ANON: n } makes that binding refuse after n calls per key.
export async function createEnv({ limits = {} } = {}) {
  let clock = Date.parse('2026-10-15T09:00:00Z');
  const turnstileCalls = [];
  const limiter = (max) => {
    const counts = new Map();
    return { async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= max }; } };
  };
  const env = {
    DB: await createD1(),
    RP_ID: 'localhost',
    RP_NAME: 'Buddy',
    ALLOWED_ORIGINS: ORIGIN,
    RECOVERY_PEPPER: 'test-pepper-not-a-secret',
    TURNSTILE_SECRET: 'test-turnstile-secret',
    LIMIT_ANON: limiter(limits.LIMIT_ANON ?? Infinity),
    LIMIT_USER: limiter(limits.LIMIT_USER ?? Infinity),
    CLOCK: () => clock,
    FETCH: async (url, init) => {
      turnstileCalls.push({ url, token: init.body.get('response'), secret: init.body.get('secret') });
      return Response.json({ success: init.body.get('response') === 'human' });
    },
  };
  return {
    env,
    turnstileCalls,
    advance: (ms) => (clock += ms),
    async call(method, path, { body, token, ip = '203.0.113.7', origin = ORIGIN, contentType = 'application/json', raw } = {}) {
      const headers = { 'cf-connecting-ip': ip };
      if (origin) headers.origin = origin;
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined || raw !== undefined) headers['content-type'] = contentType;
      const response = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
      const text = await response.text();
      return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
    },
    sql: (query, ...params) => env.DB.sqlite.prepare(query).all(...params).map((row) => ({ ...row })),
  };
}

export async function registerWithPasskey(api, authenticator) {
  const options = await api.call('POST', '/auth/register/options', { body: { turnstileToken: 'human' } });
  const response = await authenticator.register(options.data.options, ORIGIN);
  return api.call('POST', '/auth/register/verify', { body: { challengeId: options.data.challengeId, response } });
}

export async function loginWithPasskey(api, authenticator, overrides = {}) {
  const options = await api.call('POST', '/auth/login/options', { body: {} });
  const response = await authenticator.authenticate(options.data.options, overrides.origin ?? ORIGIN, overrides);
  return api.call('POST', '/auth/login/verify', { body: { challengeId: options.data.challengeId, response } });
}
