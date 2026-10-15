import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createEnv, registerWithPasskey, loginWithPasskey, ORIGIN } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { normalizeRecoveryCode, generateRecoveryCode, CODE_LENGTH } from '../src/recovery.js';
import { RECOVER_FAILURE_THRESHOLD, RECOVER_PAUSE_MS } from '../src/limits.js';
import { SESSION_MS, ADMIN_SESSION_MS } from '../src/sessions.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function registerCodeOnly(api, ip) {
  return api.call('POST', '/auth/register/code-only', { body: { turnstileToken: 'human' }, ip });
}

test('health и CORS: свой сайт получает заголовки, чужой — нет', async () => {
  const api = await createEnv();
  const ok = await api.call('GET', '/health');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const foreign = await api.call('GET', '/health', { origin: 'https://evil.example' });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  const preflight = await api.call('OPTIONS', '/auth/login/options');
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal((await api.call('GET', '/nowhere')).status, 404);
});

test('регистрация по passkey: сессия, код восстановления; в базе только хэши', async () => {
  const api = await createEnv();
  const result = await registerWithPasskey(api, await createAuthenticator());
  assert.equal(result.status, 201);
  const { session, recoveryCode, user } = result.data;
  assert.match(recoveryCode, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.equal(user.passkeys, 1);
  assert.equal(user.role, 'user');
  assert.equal(user.hasRecoveryCode, true);
  assert.equal(user.admin, false);

  const [stored] = api.sql('SELECT token_hash FROM sessions');
  assert.notEqual(stored.token_hash, session.token);
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
  const [code] = api.sql('SELECT code_hmac FROM recovery_codes');
  assert.notEqual(code.code_hmac, normalizeRecoveryCode(recoveryCode));
  assert.match(code.code_hmac, /^[0-9a-f]{64}$/);

  const me = await api.call('GET', '/me', { token: session.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, user.id);
});

test('без входа и с чужим токеном закрытые адреса отвечают 401', async () => {
  const api = await createEnv();
  assert.equal((await api.call('GET', '/me')).status, 401);
  assert.equal((await api.call('GET', '/me', { token: 'A'.repeat(43) })).status, 401);
  assert.equal((await api.call('GET', '/admin/users')).status, 401);
  assert.equal((await api.call('POST', '/me/recovery-code', { body: {} })).status, 401);
});

test('вход по passkey; один запрос — один вход; счётчик растёт', async () => {
  const api = await createEnv();
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  const login = await loginWithPasskey(api, passkey);
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, registered.data.user.id);
  assert.equal(api.sql('SELECT counter FROM credentials')[0].counter, 1);

  const options = await api.call('POST', '/auth/login/options', { body: {} });
  const response = await passkey.authenticate(options.data.options, ORIGIN);
  assert.equal((await api.call('POST', '/auth/login/verify', { body: { challengeId: options.data.challengeId, response } })).status, 200);
  const replay = await api.call('POST', '/auth/login/verify', { body: { challengeId: options.data.challengeId, response } });
  assert.equal(replay.status, 400);
  assert.equal(replay.data.error, 'challenge_expired');
});

test('passkey с чужого сайта, чужой домен или устаревший запрос не принимаются', async () => {
  const api = await createEnv();
  const passkey = await createAuthenticator();
  await registerWithPasskey(api, passkey);
  assert.equal((await loginWithPasskey(api, passkey, { origin: 'https://evil.example' })).data.error, 'passkey_invalid');
  assert.equal((await loginWithPasskey(api, passkey, { rpId: 'evil.example' })).data.error, 'passkey_invalid');

  const options = await api.call('POST', '/auth/login/options', { body: {} });
  api.advance(5 * 60 * 1000 + 1);
  const response = await passkey.authenticate(options.data.options, ORIGIN);
  assert.equal((await api.call('POST', '/auth/login/verify', { body: { challengeId: options.data.challengeId, response } })).data.error, 'challenge_expired');

  const stranger = await createAuthenticator();
  assert.equal((await loginWithPasskey(api, stranger)).data.error, 'passkey_unknown');
});

test('создание учётной записи требует Turnstile; без секрета сервер отказывает', async () => {
  const api = await createEnv();
  assert.equal((await api.call('POST', '/auth/register/options', { body: {} })).data.error, 'turnstile_missing');
  assert.equal((await api.call('POST', '/auth/register/options', { body: { turnstileToken: 'bot' } })).status, 403);
  assert.equal((await api.call('POST', '/auth/register/code-only', { body: { turnstileToken: 'bot' } })).status, 403);
  assert.equal(api.turnstileCalls.at(-1).secret, 'test-turnstile-secret');
  const revoked = await api.call('POST', '/auth/register/code-only', { body: { turnstileToken: 'revoked-secret' } });
  assert.equal(revoked.status, 503, 'неверный ключ сервера — не вина посетителя');
  assert.equal(revoked.data.error, 'unconfigured');
  delete api.env.TURNSTILE_SECRET;
  assert.equal((await api.call('POST', '/auth/register/options', { body: { turnstileToken: 'human' } })).status, 503);
  assert.equal(api.sql('SELECT COUNT(*) n FROM users')[0].n, 0);
});

test('код восстановления: вход, старый код сгорает, выдаётся новый; ввод прощает регистр, пробелы, O/0 и I/1', async () => {
  const api = await createEnv();
  const created = await registerCodeOnly(api);
  assert.equal(created.status, 201);
  assert.equal(created.data.user.passkeys, 0);
  const typed = created.data.recoveryCode.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'i');

  const recovered = await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: typed } });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.user.id, created.data.user.id);
  assert.notEqual(recovered.data.recoveryCode, created.data.recoveryCode);

  const again = await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: created.data.recoveryCode }, ip: '198.51.100.1' });
  assert.equal(again.status, 401);
  const next = await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: recovered.data.recoveryCode }, ip: '198.51.100.1' });
  assert.equal(next.status, 200);
});

test('код восстановления: 100 бит, не больше 5 попыток в час с одного IP', async () => {
  for (let i = 0; i < 50; i++) assert.equal(normalizeRecoveryCode(generateRecoveryCode()).length, CODE_LENGTH);
  assert.equal(CODE_LENGTH * 5, 100);
  assert.equal(normalizeRecoveryCode('short'), null);
  assert.equal(normalizeRecoveryCode('UUUUU-UUUUU-UUUUU-UUUUU'), null);

  const api = await createEnv();
  const created = await registerCodeOnly(api);
  for (let i = 0; i < 5; i++) {
    assert.equal((await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: 'AAAAA-AAAAA-AAAAA-AAAAA' } })).status, 401);
  }
  const blocked = await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: created.data.recoveryCode } });
  assert.equal(blocked.status, 429, 'даже верный код не принимается после 5 попыток');
  api.advance(HOUR);
  assert.equal((await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: created.data.recoveryCode } })).status, 200);
});

test('всплеск неудачных кодов по всему сервису приостанавливает вход по коду на полчаса', async () => {
  const api = await createEnv();
  const created = await registerCodeOnly(api);
  for (let i = 0; i < RECOVER_FAILURE_THRESHOLD; i++) {
    await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: 'BBBBB-BBBBB-BBBBB-BBBBB' }, ip: `10.0.${Math.floor(i / 5)}.${i % 5}` });
  }
  const paused = await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: created.data.recoveryCode }, ip: '192.0.2.200' });
  assert.equal(paused.status, 503);
  assert.equal(paused.data.error, 'recover_paused');
  api.advance(RECOVER_PAUSE_MS + 1);
  assert.equal((await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: created.data.recoveryCode }, ip: '192.0.2.200' })).status, 200);
});

test('администратор: только passkey с проверкой личности, сессия 12 часов, роль проверяется по базе, действия в журнале', async () => {
  const api = await createEnv();
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  const adminId = registered.data.user.id;
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", adminId);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', adminId);

  assert.equal((await api.call('GET', '/admin/users', { token: registered.data.session.token })).status, 403, 'обычная сессия не открывает /admin');

  const login = await loginWithPasskey(api, passkey);
  assert.equal(login.data.user.admin, true);
  const expires = Date.parse(login.data.session.expiresAt) - api.env.CLOCK();
  assert.equal(expires, ADMIN_SESSION_MS);
  const users = await api.call('GET', '/admin/users', { token: login.data.session.token });
  assert.equal(users.status, 200);
  assert.equal(users.data.users.length, 1);
  assert.deepEqual(api.sql('SELECT admin_id, action FROM admin_audit'), [{ admin_id: adminId, action: 'list_users' }]);

  assert.equal((await api.call('POST', '/me/recovery-code', { token: login.data.session.token, body: {} })).status, 403);

  api.advance(ADMIN_SESSION_MS + 1);
  assert.equal((await api.call('GET', '/admin/users', { token: login.data.session.token })).status, 401);

  const fresh = await loginWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'user' WHERE id = ?", adminId);
  assert.equal((await api.call('GET', '/admin/users', { token: fresh.data.session.token })).status, 403, 'снятая роль действует сразу');
});

test('администратор без проверки личности (PIN, отпечаток) не получает доступ к /admin', async () => {
  const api = await createEnv();
  const passkey = await createAuthenticator({ userVerified: false });
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  assert.equal(login.status, 200);
  assert.equal(login.data.user.admin, false);
  assert.equal((await api.call('GET', '/admin/users', { token: login.data.session.token })).status, 403);
});

test('код восстановления администратору не принимается', async () => {
  const api = await createEnv();
  const created = await registerCodeOnly(api);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", created.data.user.id);
  const result = await api.call('POST', '/auth/recover', { body: { turnstileToken: 'human', code: created.data.recoveryCode } });
  assert.equal(result.status, 403);
  assert.equal(result.data.error, 'admin_passkey_only');
});

test('после входа по коду можно добавить passkey и входить им', async () => {
  const api = await createEnv();
  const created = await registerCodeOnly(api);
  const token = created.data.session.token;
  const passkey = await createAuthenticator();
  const options = await api.call('POST', '/me/passkeys/options', { token, body: {} });
  const response = await passkey.register(options.data.options, ORIGIN);
  const added = await api.call('POST', '/me/passkeys/verify', { token, body: { challengeId: options.data.challengeId, response } });
  assert.equal(added.status, 201);
  assert.equal(added.data.user.passkeys, 1);
  assert.equal((await loginWithPasskey(api, passkey)).data.user.id, created.data.user.id);

  const other = await registerCodeOnly(api, '198.51.100.9');
  const foreign = await api.call('POST', '/me/passkeys/options', { token, body: {} });
  const stolen = await (await createAuthenticator()).register(foreign.data.options, ORIGIN);
  const misuse = await api.call('POST', '/me/passkeys/verify', { token: other.data.session.token, body: { challengeId: foreign.data.challengeId, response: stolen } });
  assert.equal(misuse.status, 400, 'запрос на добавление passkey нельзя использовать из другой учётной записи');
});

test('сессия: 30 дней, продлевается при использовании, выход удаляет её', async () => {
  const api = await createEnv();
  const { data } = await registerCodeOnly(api);
  assert.equal(Date.parse(data.session.expiresAt) - api.env.CLOCK(), SESSION_MS);
  api.advance(20 * DAY);
  assert.equal((await api.call('GET', '/me', { token: data.session.token })).status, 200);
  api.advance(20 * DAY);
  assert.equal((await api.call('GET', '/me', { token: data.session.token })).status, 200, 'сессия продлилась');
  assert.equal((await api.call('POST', '/auth/logout', { token: data.session.token })).status, 204);
  assert.equal((await api.call('GET', '/me', { token: data.session.token })).status, 401);

  const idle = await registerCodeOnly(api, '198.51.100.2');
  api.advance(SESSION_MS + 1);
  assert.equal((await api.call('GET', '/me', { token: idle.data.session.token })).status, 401);
});

test('ограничения частоты и размера запросов', async () => {
  const api = await createEnv({ limits: { LIMIT_ANON: 2 } });
  assert.equal((await api.call('POST', '/auth/login/options', { body: {} })).status, 200);
  assert.equal((await api.call('POST', '/auth/login/options', { body: {} })).status, 200);
  assert.equal((await api.call('POST', '/auth/login/options', { body: {} })).status, 429);
  assert.equal((await api.call('POST', '/auth/login/options', { body: {}, ip: '198.51.100.3' })).status, 200, 'другой IP не страдает');

  const big = await api.call('POST', '/auth/login/verify', { raw: JSON.stringify({ pad: 'x'.repeat(33 * 1024) }), ip: '198.51.100.4' });
  assert.equal(big.status, 413);
  assert.equal((await api.call('POST', '/auth/login/verify', { raw: '{}', contentType: 'text/plain', ip: '198.51.100.5' })).status, 415);
  assert.equal((await api.call('POST', '/auth/login/verify', { raw: '{oops', ip: '198.51.100.6' })).status, 400);
});

test('плановая очистка удаляет просроченные запросы и сессии', async () => {
  const api = await createEnv();
  await api.call('POST', '/auth/login/options', { body: {} });
  await registerCodeOnly(api);
  api.advance(SESSION_MS + 1);
  const waits = [];
  await worker.scheduled({}, api.env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(api.sql('SELECT COUNT(*) n FROM challenges')[0].n, 0);
  assert.equal(api.sql('SELECT COUNT(*) n FROM sessions')[0].n, 0);
  assert.equal(api.sql('SELECT COUNT(*) n FROM users')[0].n, 1, 'учётные записи не удаляются');
});
