import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { buildBiPrompt, buildSiPrompt } from '../src/dcb/prompts.js';
import { estimateCostMicros, actualCostMicros, DCB_GRANT_MICROS, resolvePriceTable } from '../src/dcb/budget.js';
import { readFile } from 'node:fs/promises';

// Plain marker for isolation tests — must not look like an API key (gitleaks).
const SECRET_MARKER = 'hidden-bio-marker-for-isolation-test';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  assert.equal(login.data.user.admin, true);
  return { token: login.data.session.token, userId: login.data.user.id, passkey };
}

function mockOpenAi(api, handler) {
  const calls = [];
  const realFetch = api.env.FETCH;
  api.env.OPENAI_API_KEY = 'test-openai-placeholder';
  api.env.FETCH = async (url, init) => {
    if (String(url).includes('openai.com')) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const result = handler(body, calls.length);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(result.json) } }],
        usage: { prompt_tokens: result.prompt_tokens ?? 100, completion_tokens: result.completion_tokens ?? 50 },
      });
    }
    return realFetch(url, init);
  };
  return calls;
}

test('промпт Би не содержит secret_bio; промпт Си содержит', () => {
  const secret = `Биография с маркером ${SECRET_MARKER}`;
  const bi = buildBiPrompt({
    mode: 'small',
    messages: [{ speaker: 'bi', text: 'Как вас зовут?' }],
    model: { biography: '', facts: [], hypotheses: [], unknowns: [] },
  });
  const si = buildSiPrompt({
    mode: 'small',
    secretBio: secret,
    memoryFacts: [],
    messages: [{ speaker: 'bi', text: 'Как вас зовут?' }],
  });
  assert.doesNotMatch(`${bi.system}\n${bi.user}`, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(`${bi.system}\n${bi.user}`, /secret/i);
  assert.match(`${si.system}\n${si.user}`, new RegExp(SECRET_MARKER));
  assert.match(bi.system, /пол/);
  assert.match(bi.system, /возраст/);
  assert.match(bi.system, /обращ/);
  assert.match(bi.user, /пол/);
});

test('промпт Би с фото: угадать можно, но нужно подтверждение; секрет не утекает', () => {
  const secret = `Биография с маркером ${SECRET_MARKER}`;
  const bi = buildBiPrompt({
    mode: 'small',
    messages: [],
    model: { biography: '', facts: [], hypotheses: [], unknowns: [] },
    hasPhoto: true,
    photos: [{ seq: 1, label: 'портрет' }, { seq: 2, label: 'дом' }],
  });
  assert.match(bi.system, /фото/i);
  assert.match(bi.system, /подтвержд/i);
  assert.match(bi.user, /фото №2/);
  assert.match(bi.user, /дом/);
  assert.doesNotMatch(`${bi.system}\n${bi.user}`, new RegExp(SECRET_MARKER));
  assert.doesNotMatch(`${bi.system}\n${bi.user}`, new RegExp(secret));
});

test('бюджет: оценка стоимости и жёсткий потолок $10', () => {
  assert.equal(DCB_GRANT_MICROS, 10_000_000);
  const est = estimateCostMicros({ inputTokens: 1000, maxOutputTokens: 500 });
  assert.ok(est > 0);
  const act = actualCostMicros({ inputTokens: 1000, outputTokens: 100 });
  assert.ok(act > 0 && act <= est);
  assert.equal(resolvePriceTable({}).model, 'gpt-6-luna');
  assert.equal(resolvePriceTable({ OPENAI_MODEL: 'gpt-6.1-sol' }).model, 'gpt-6.1-sol');
});

test('OpenAI: нет доступа к модели — понятное сообщение с именем модели', async () => {
  const api = await createEnv();
  const { token } = await asAdmin(api);
  const persona = await api.call('POST', '/dcb/personas', {
    token,
    body: { title: 'Си', secretBio: 'Факт.' },
  });
  const session = await api.call('POST', '/dcb/sessions', {
    token,
    body: { personaId: persona.data.persona.id, mode: 'small' },
  });
  api.env.OPENAI_API_KEY = 'test-openai-placeholder';
  api.env.OPENAI_MODEL = 'gpt-6-luna';
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    if (String(url).includes('openai.com')) {
      return new Response(JSON.stringify({
        error: { message: 'The model `gpt-6-luna` does not exist or you do not have access to it.', code: 'model_not_found' },
      }), { status: 404 });
    }
    return realFetch(url, init);
  };
  const bi = await api.call('POST', `/dcb/sessions/${session.data.session.id}/bi`, { token, body: {} });
  assert.equal(bi.status, 502);
  assert.equal(bi.data.error, 'openai_forbidden');
  assert.match(bi.data.message, /gpt-6-luna/);
  assert.match(bi.data.message, /OPENAI_MODEL/);
});

test('схема DCB отделена от личных диалогов Buddy; есть бюджет и secret_bio', async () => {
  const schema = await readFile(new URL('../migrations/0002_dcb.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE dcb_personas/);
  assert.match(schema, /secret_bio/);
  assert.match(schema, /granted_micros INTEGER NOT NULL/);
  assert.match(schema, /10000000/);
  assert.match(schema, /personal chats and journal stay on the device/i);
  const photo = await readFile(new URL('../migrations/0003_dcb_photo.sql', import.meta.url), 'utf8');
  assert.match(photo, /photo_data/);
  const sessionPhotos = await readFile(new URL('../migrations/0004_dcb_session_photos.sql', import.meta.url), 'utf8');
  assert.match(sessionPhotos, /dcb_session_photos/);
});

test('DCB: только elevated admin; CRUD Си; изоляция маркера в вызовах OpenAI', async () => {
  const api = await createEnv();
  assert.equal((await api.call('GET', '/dcb/personas')).status, 401);

  const userKey = await createAuthenticator();
  const user = await registerWithPasskey(api, userKey);
  assert.equal((await api.call('GET', '/dcb/personas', { token: user.data.session.token })).status, 403);

  const { token } = await asAdmin(api);
  const created = await api.call('POST', '/dcb/personas', {
    token,
    body: { title: 'Тест Си', secretBio: `Жил-был человек. ${SECRET_MARKER}. Дружил с Петром.` },
  });
  assert.equal(created.status, 201);
  assert.match(created.data.persona.secretBio, new RegExp(SECRET_MARKER));

  const list = await api.call('GET', '/dcb/personas', { token });
  assert.equal(list.data.personas.length, 1);
  assert.equal(list.data.personas[0].secretBio, undefined, 'в списке нет скрытого описания');

  const tinyPhoto = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAwEPwAB/9k=';
  const withPhoto = await api.call('PATCH', `/dcb/personas/${created.data.persona.id}`, {
    token,
    body: { photoData: tinyPhoto },
  });
  assert.equal(withPhoto.status, 200);
  assert.equal(withPhoto.data.persona.hasPhoto, true);
  assert.equal(withPhoto.data.persona.photoData, tinyPhoto);

  const secondPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let biCalls = 0;
  const calls = mockOpenAi(api, (body) => {
    const blob = JSON.stringify(body.messages);
    const isBi = /Вы — Би/.test(blob);
    const isSi = /Вы — Си/.test(blob);
    if (isBi) {
      biCalls += 1;
      assert.doesNotMatch(blob, new RegExp(SECRET_MARKER), 'утечка секрета в ход Би');
      const user = body.messages.find((m) => m.role === 'user');
      assert.ok(Array.isArray(user.content), 'Би получает multimodal с фото');
      const urls = user.content.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url);
      assert.ok(urls.includes(tinyPhoto) || urls.includes(secondPhoto), 'Би видит фото сеанса');
      return { json: { utterance: 'По фото похоже, вы женщина — так?', facts: [], hypotheses: ['женщина'], unknowns: ['возраст', 'обращение'], biography: '' } };
    }
    if (isSi) {
      assert.match(blob, new RegExp(SECRET_MARKER), 'Си должен видеть секрет');
      assert.equal(typeof body.messages.find((m) => m.role === 'user').content, 'string', 'Си не получает фото');
      return { json: { utterance: 'Меня зовут Анна.', new_facts: [] } };
    }
    return { json: { ok: true } };
  });

  const session = await api.call('POST', '/dcb/sessions', {
    token,
    body: { personaId: created.data.persona.id, mode: 'small' },
  });
  assert.equal(session.status, 201);
  assert.equal(session.data.session.mode, 'small');
  assert.equal(session.data.session.hasPhoto, true);
  assert.equal(session.data.session.photoCount, 1);
  assert.equal(session.data.session.photos[0].label, 'портрет');
  assert.match(session.data.session.biStrategyVersion, /dcb-bi-facts-v2/);

  const added = await api.call('POST', `/dcb/sessions/${session.data.session.id}/photos`, {
    token,
    body: { photoData: secondPhoto, label: 'с друзьями' },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.session.photoCount, 2);
  assert.equal(added.data.photo.seq, 2);

  // Photo-only patch on persona still allowed while session is active.
  const photoOnly = await api.call('PATCH', `/dcb/personas/${created.data.persona.id}`, {
    token,
    body: { photoData: tinyPhoto },
  });
  assert.equal(photoOnly.status, 200);
  const bioBlocked = await api.call('PATCH', `/dcb/personas/${created.data.persona.id}`, {
    token,
    body: { secretBio: 'Новое описание' },
  });
  assert.equal(bioBlocked.status, 409);

  const bi = await api.call('POST', `/dcb/sessions/${session.data.session.id}/bi`, { token, body: {} });
  assert.equal(bi.status, 200);
  assert.equal(bi.data.message.speaker, 'bi');
  assert.ok(biCalls >= 1);

  const si = await api.call('POST', `/dcb/sessions/${session.data.session.id}/si`, { token, body: {} });
  assert.equal(si.status, 200);
  assert.equal(si.data.message.text, 'Меня зовут Анна.');
  assert.ok(calls.length >= 2);

  const promoted = await api.call('POST', `/dcb/sessions/${session.data.session.id}/promote`, { token, body: {} });
  assert.equal(promoted.data.session.mode, 'large');

  const finished = await api.call('POST', `/dcb/sessions/${session.data.session.id}/finish`, { token, body: {} });
  assert.equal(finished.data.session.status, 'finished');

  const review = await api.call('POST', `/dcb/sessions/${session.data.session.id}/review`, {
    token,
    body: { score: 4, good: 'Хорошие вопросы', mistakes: '', missed: '', comment: 'ок' },
  });
  assert.equal(review.status, 200);
  assert.equal(review.data.session.review.score, 4);

  const ideas = await api.call('POST', `/dcb/sessions/${session.data.session.id}/ideas`, {
    token,
    body: { strategy: 'Больше про людей', acquaintance: '', siNotes: '', nextTrials: 'Большой сеанс' },
  });
  assert.equal(ideas.data.session.ideas.strategy, 'Больше про людей');

  const exported = await api.call('GET', `/dcb/sessions/${session.data.session.id}/export`, { token });
  assert.equal(exported.data.format, 'buddy-dcb-session');
  assert.match(exported.data.session.secretBio, new RegExp(SECRET_MARKER));
});

test('DCB: бюджет не даёт превысить $10', async () => {
  const api = await createEnv();
  const { token } = await asAdmin(api);
  const persona = await api.call('POST', '/dcb/personas', {
    token,
    body: { title: 'Си', secretBio: 'Факт один.' },
  });
  const session = await api.call('POST', '/dcb/sessions', {
    token,
    body: { personaId: persona.data.persona.id, mode: 'small' },
  });
  // Spend almost the whole purse: set spent near the grant.
  api.sql('UPDATE dcb_budget SET spent_micros = ? WHERE id = 1', DCB_GRANT_MICROS - 1);
  mockOpenAi(api, () => ({ json: { utterance: 'x', facts: [], hypotheses: [], unknowns: [], biography: '' }, prompt_tokens: 100000, completion_tokens: 100000 }));
  const bi = await api.call('POST', `/dcb/sessions/${session.data.session.id}/bi`, { token, body: {} });
  assert.equal(bi.status, 402);
  assert.equal(bi.data.error, 'budget_exhausted');
});

test('DCB: в малом режиме new_facts Си не сохраняются', async () => {
  const api = await createEnv();
  const { token } = await asAdmin(api);
  const persona = await api.call('POST', '/dcb/personas', {
    token,
    body: { title: 'Си', secretBio: `Маркер ${SECRET_MARKER}` },
  });
  const session = await api.call('POST', '/dcb/sessions', {
    token,
    body: { personaId: persona.data.persona.id, mode: 'small' },
  });
  let n = 0;
  mockOpenAi(api, () => {
    n += 1;
    if (n === 1) return { json: { utterance: 'Вопрос?', facts: [], hypotheses: [], unknowns: [], biography: '' } };
    return { json: { utterance: 'Ответ', new_facts: ['Выдуманный факт'] } };
  });
  await api.call('POST', `/dcb/sessions/${session.data.session.id}/bi`, { token, body: {} });
  const si = await api.call('POST', `/dcb/sessions/${session.data.session.id}/si`, { token, body: {} });
  assert.deepEqual(si.data.savedFacts, []);
  assert.equal(si.data.session.memory.length, 0);
});
