import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/src/index.js';
import { createEnv, ORIGIN } from '../server/test/harness.mjs';
import { createAuthenticator } from '../server/test/authenticator.mjs';
import { createApi, ApiError } from '../web/api.js';
import {
  toBase64Url, fromBase64Url, creationOptions, requestOptions, registrationJson, authenticationJson,
} from '../web/webauthn.js';
import { API_BASE, TURNSTILE_SITE_KEY } from '../web/config.js';

// Connects web/api.js to the real Worker, the way a browser on ORIGIN would.
async function connect() {
  const server = await createEnv();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const headers = { ...init.headers, origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9' };
    return worker.fetch(new Request(url, { method: init.method, headers, body: init.body }), server.env);
  };
  return { server, sent, api: createApi('https://api.test', fetchImpl) };
}

test('api.js: регистрация, вход и passkey работают с настоящим сервером', async () => {
  const { api, sent } = await connect();
  const passkey = await createAuthenticator();

  const reg = await api.registerOptions('human');
  const created = await api.registerVerify(reg.challengeId, await passkey.register(reg.options, ORIGIN));
  assert.match(created.recoveryCode, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.equal((await api.me(created.session.token)).user.passkeys, 1);

  const login = await api.loginOptions();
  const signedIn = await api.loginVerify(login.challengeId, await passkey.authenticate(login.options, ORIGIN));
  assert.equal(signedIn.user.id, created.user.id);

  assert.equal(await api.logout(signedIn.session.token), null);
  await assert.rejects(api.me(signedIn.session.token), (error) => error instanceof ApiError && error.status === 401);

  for (const request of sent) {
    assert.equal(request.credentials, 'omit', 'cookies не отправляются');
    assert.equal(request.cache, 'no-store');
  }
  assert.equal(sent.find((r) => r.url.endsWith('/me')).headers.Authorization, `Bearer ${created.session.token}`);
});

test('api.js: отправляет только данные для входа', async () => {
  const { api, sent } = await connect();
  const created = await api.registerCodeOnly('human');
  const recovered = await api.recover(created.recoveryCode.toLowerCase(), 'human');
  await api.newRecoveryCode(recovered.session.token);
  const allowed = new Set(['turnstileToken', 'challengeId', 'response', 'code']);
  for (const { body } of sent) {
    for (const key of Object.keys(body ?? {})) assert.ok(allowed.has(key), `в запросе лишнее поле ${key}`);
  }
});

test('api.js: понятные ошибки — сервер, сеть, сервер не подключён', async () => {
  const { api } = await connect();
  await assert.rejects(api.recover('AAAAA-AAAAA-AAAAA-AAAAA', 'human'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'code_invalid');
    assert.match(error.message, /Код не подошёл/);
    return true;
  });
  const offline = createApi('https://api.test', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(offline.health(), (error) => error.code === 'offline' && /Нет связи/.test(error.message));
  const none = createApi('');
  assert.equal(none.configured, false);
  await assert.rejects(none.health(), (error) => error.code === 'not_configured');
});

test('config.js: вне localhost сервер не подключён, пока его не развернули', () => {
  assert.equal(API_BASE, '');
  assert.equal(TURNSTILE_SITE_KEY, '');
});

test('webauthn.js: base64url и преобразование параметров passkey', () => {
  for (let length = 0; length < 8; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 250) % 256);
    const text = toBase64Url(bytes);
    assert.doesNotMatch(text, /[+/=]/);
    assert.deepEqual(fromBase64Url(text), bytes);
  }
  const created = creationOptions({
    challenge: 'AQID', user: { id: 'BAU', name: 'buddy-1', displayName: 'Buddy' }, rp: { id: 'localhost', name: 'Buddy' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ id: 'Bgc', type: 'public-key' }],
  });
  assert.deepEqual(created.challenge, Uint8Array.of(1, 2, 3));
  assert.deepEqual(created.user.id, Uint8Array.of(4, 5));
  assert.deepEqual(created.excludeCredentials[0].id, Uint8Array.of(6, 7));
  assert.equal(created.rp.id, 'localhost');
  assert.deepEqual(requestOptions({ challenge: 'CQ', rpId: 'localhost' }).allowCredentials, []);

  const buffer = (...bytes) => Uint8Array.from(bytes).buffer;
  const registration = registrationJson({
    id: 'AQ', rawId: buffer(1), type: 'public-key', authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    response: { clientDataJSON: buffer(2), attestationObject: buffer(3), getTransports: () => ['internal'] },
  });
  assert.deepEqual(registration.response, { clientDataJSON: 'Ag', attestationObject: 'Aw', transports: ['internal'] });
  const assertion = authenticationJson({
    id: 'AQ', rawId: buffer(1), type: 'public-key',
    response: { clientDataJSON: buffer(2), authenticatorData: buffer(3), signature: buffer(4), userHandle: null },
  });
  assert.deepEqual(assertion.response, { clientDataJSON: 'Ag', authenticatorData: 'Aw', signature: 'BA', userHandle: undefined });
  assert.deepEqual(assertion.clientExtensionResults, {});
});
