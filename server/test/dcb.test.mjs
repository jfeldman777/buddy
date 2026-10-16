import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { buildBiPrompt, buildSiPrompt } from '../src/dcb/prompts.js';
import { estimateCostMicros, actualCostMicros, DCB_GRANT_MICROS } from '../src/dcb/budget.js';
import { readFile } from 'node:fs/promises';

const SECRET_MARKER = 'SECRET_MARKER_XYZ_ISOLATION_77';

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
  api.env.OPENAI_API_KEY = 'test-openai-key-not-secret';
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
});

test('бюджет: оценка стоимости и жёсткий потолок $10', () => {
  assert.equal(DCB_GRANT_MICROS, 10_000_000);
  const est = estimateCostMicros({ inputTokens: 1000, maxOutputTokens: 500 });
  assert.ok(est > 0);
  const act = actualCostMicros({ inputTokens: 1000, outputTokens: 100 });
  assert.ok(act > 0 && act <= est);
});

test('схема DCB отделена от личных диалогов Buddy; есть бюджет и secret_bio', async () => {
  const schema = await readFile(new URL('../migrations/0002_dcb.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE TABLE dcb_personas/);
  assert.match(schema, /secret_bio/);
  assert.match(schema, /granted_micros INTEGER NOT NULL/);
  assert.match(schema, /10000000/);
  assert.match(schema, /personal chats and journal stay on the device/i);
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

  const calls = mockOpenAi(api, (body) => {
    const blob = JSON.stringify(body.messages);
    const isBi = /Вы — Би/.test(blob);
    const isSi = /Вы — Си/.test(blob);
    if (isBi) {
      assert.doesNotMatch(blob, new RegExp(SECRET_MARKER), 'утечка секрета в ход Би');
      return { json: { utterance: 'Как вас зовут?', facts: [], hypotheses: ['Короткое имя'], unknowns: ['возраст'], biography: '' } };
    }
    if (isSi) {
      assert.match(blob, new RegExp(SECRET_MARKER), 'Си должен видеть секрет');
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

  const bi = await api.call('POST', `/dcb/sessions/${session.data.session.id}/bi`, { token, body: {} });
  assert.equal(bi.status, 200);
  assert.equal(bi.data.message.speaker, 'bi');

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
