import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import {
  DEFAULT_CHAT_GRANT_MICROS, resolveChatGrantMicros, chatBudgetView,
  reserveChatStrict, settleChat,
} from '../src/bi/chatBudget.js';
import { DCB_GRANT_MICROS, budgetView, reserveStrict } from '../src/dcb/budget.js';
import { MEMORY_CONSENT_VERSION } from '../src/bi/consent.js';
import { buildABiPrompt } from '../src/bi/prompts.js';

async function asUser(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

test('Buddy-011 схема: память, context, KB, chat budget $1 отдельно от DCB', async () => {
  const sql = await readFile(new URL('../migrations/0005_buddy011_memory.sql', import.meta.url), 'utf8');
  assert.match(sql, /buddy_chat_budget/);
  assert.match(sql, /1000000/);
  assert.match(sql, /bi_memory_consent/);
  assert.match(sql, /bi_memory_entries/);
  assert.match(sql, /bi_conversation_context/);
  assert.match(sql, /bi_teachings/);
  assert.match(sql, /kb_shared/);
  assert.match(sql, /bi_strategies/);
  assert.doesNotMatch(sql, /dcb_budget/, 'миграция 0005 не трогает кошелёк DCB');
  assert.equal(DEFAULT_CHAT_GRANT_MICROS, 1_000_000);
  assert.equal(DCB_GRANT_MICROS, 10_000_000);
  assert.notEqual(DEFAULT_CHAT_GRANT_MICROS, DCB_GRANT_MICROS);
});

test('чат-бюджет: жёсткий потолок, отдельно от DCB', async () => {
  const api = await createEnv();
  assert.equal(resolveChatGrantMicros({}), 1_000_000);
  assert.equal(resolveChatGrantMicros({ CHAT_BUDGET_MICROS: '1000000' }), 1_000_000);

  const chat = await chatBudgetView(api.env);
  assert.equal(chat.grantedMicros, 1_000_000);
  assert.equal(chat.purse, 'buddy_chat');
  assert.equal(chat.remainingMicros, 1_000_000);

  const dcb = await budgetView(api.env);
  assert.equal(dcb.grantedMicros, 10_000_000);

  const reservation = await reserveChatStrict(api.env, 'sess-chat', 600_000);
  await settleChat(api.env, reservation.id, 600_000, {
    sessionId: 'sess-chat', speaker: 'bi', model: 'test', inputTokens: 10, outputTokens: 10,
  });

  const after = await chatBudgetView(api.env);
  assert.equal(after.spentMicros, 600_000);
  assert.equal(after.remainingMicros, 400_000);

  await assert.rejects(
    () => reserveChatStrict(api.env, 'sess-chat-2', 500_000),
    (err) => err.status === 402 && err.code === 'chat_budget_exhausted',
  );

  // DCB purse untouched.
  const dcbAfter = await budgetView(api.env);
  assert.equal(dcbAfter.spentMicros, 0);
  assert.equal(dcbAfter.grantedMicros, 10_000_000);
  await reserveStrict(api.env, 'dcb-sess', 1);
  const dcbReserved = await budgetView(api.env);
  assert.equal(dcbReserved.reservedMicros, 1);
  const chatStill = await chatBudgetView(api.env);
  assert.equal(chatStill.reservedMicros, 0);
});

test('чат-бюджет: конфиг не даёт опустить грант ниже spent+reserved', async () => {
  const api = await createEnv();
  api.sql('UPDATE buddy_chat_budget SET spent_micros = 500000 WHERE id = 1');
  api.env.CHAT_BUDGET_MICROS = '100000';
  await assert.rejects(() => chatBudgetView(api.env), (err) => err.code === 'misconfigured');
});

test('API: consent и budget для вошедшего пользователя; без сессии 401', async () => {
  const api = await createEnv();
  assert.equal((await api.call('GET', '/chat/consent')).status, 401);
  assert.equal((await api.call('GET', '/chat/budget')).status, 401);

  const { token } = await asUser(api);
  const before = await api.call('GET', '/chat/consent', { token });
  assert.equal(before.status, 200);
  assert.equal(before.data.consent.given, false);
  assert.equal(before.data.consent.version, MEMORY_CONSENT_VERSION);
  assert.match(before.data.consent.text, /структурированную личную память/);

  const denied = await api.call('POST', '/chat/consent', { token, body: { accept: false } });
  assert.equal(denied.status, 400);

  const ok = await api.call('POST', '/chat/consent', {
    token,
    body: { accept: true, version: MEMORY_CONSENT_VERSION },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.consent.given, true);

  const after = await api.call('GET', '/chat/consent', { token });
  assert.equal(after.data.consent.given, true);

  const budget = await api.call('GET', '/chat/budget', { token });
  assert.equal(budget.status, 200);
  assert.equal(budget.data.budget.grantedMicros, 1_000_000);
  assert.equal(budget.data.budget.purse, 'buddy_chat');
});

test('промпт А–Би включает память и учение; без secret_bio', () => {
  const prompt = buildABiPrompt({
    displayName: 'Ира',
    memoryEntries: [{ map: 'personality', layer: 'fact', provenance: 'confirmed', text: 'Любит шахматы' }],
    teachings: [{ formulation: 'Правило: сначала спроси, потом советуй' }],
    sharedKnowledge: [{ version: 1, formulation: 'Общее: будь краток' }],
    strategies: [],
    context: { summary: 'Говорили о работе', openThreads: ['план на выходные'] },
    hasPhoto: true,
  });
  assert.match(prompt.system, /подтверждение/i);
  assert.match(prompt.user, /Любит шахматы/);
  assert.match(prompt.user, /сначала спроси/);
  assert.match(prompt.user, /Общее: будь краток/);
  assert.match(prompt.user, /план на выходные/);
  assert.doesNotMatch(`${prompt.system}\n${prompt.user}`, /secret_bio|hidden-bio-marker/);
});

test('chat/turn: согласие, память в промпте, кошелёк chat не DCB', async () => {
  const api = await createEnv();
  const { token, userId } = await asUser(api);
  assert.equal((await api.call('POST', '/chat/turn', { token, body: { open: true } })).status, 403);

  await api.call('POST', '/chat/consent', { token, body: { accept: true } });
  const at = '2026-10-16T12:00:00.000Z';
  api.sql(
    `INSERT INTO bi_memory_entries (id, user_id, map, layer, provenance, text, source, confidence, forbidden, deleted, created_at, updated_at)
     VALUES (?, ?, 'personality', 'fact', 'confirmed', 'Факт для промпта', '', 1, 0, 0, ?, ?)`,
    'mem1', userId, at, at,
  );

  const calls = [];
  api.env.OPENAI_API_KEY = 'test-key';
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    if (String(url).includes('openai.com')) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const blob = JSON.stringify(body.messages);
      assert.match(blob, /Факт для промпта/);
      assert.doesNotMatch(blob, /secret_bio/);
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          utterance: 'Помню про ваш факт. Как дела?',
          summary: 'Обсудили факт',
          open_threads: ['как дела'],
          memory_candidates: [],
          used_knowledge_ids: [],
        }) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      });
    }
    return realFetch(url, init);
  };

  const turn = await api.call('POST', '/chat/turn', { token, body: { open: true, displayName: 'Тест' } });
  assert.equal(turn.status, 200);
  assert.match(turn.data.reply, /Помню/);
  assert.equal(turn.data.budget.purse, 'buddy_chat');
  assert.ok(turn.data.budget.spentMicros > 0);
  assert.ok(calls.length >= 1);

  const dcb = await budgetView(api.env);
  assert.equal(dcb.spentMicros, 0, 'DCB кошелёк не тронут');

  const ctx = await api.call('GET', '/chat/context', { token });
  assert.equal(ctx.status, 200);
  assert.match(ctx.data.context.summary, /Обсудили факт/);
});

test('изоляция: таблицы памяти А и DCB сосуществуют после миграций', async () => {
  const api = await createEnv();
  const { userId } = await asUser(api);
  const at = '2026-10-16T00:00:00.000Z';
  api.sql(
    `INSERT INTO bi_memory_entries (id, user_id, map, layer, provenance, text, source, confidence, forbidden, deleted, created_at, updated_at)
     VALUES (?, ?, 'personality', 'fact', 'from_a', 'Тестовый факт', '', 1, 0, 0, ?, ?)`,
    'e1', userId, at, at,
  );
  api.sql(
    `INSERT INTO bi_conversation_context (user_id, summary, open_threads_json, updated_at)
     VALUES (?, 'Незавершённая тема', '[]', ?)`,
    userId, at,
  );
  const mem = api.sql('SELECT text FROM bi_memory_entries WHERE user_id = ?', userId);
  assert.equal(mem[0].text, 'Тестовый факт');
  const ctx = api.sql('SELECT summary FROM bi_conversation_context WHERE user_id = ?', userId);
  assert.equal(ctx[0].summary, 'Незавершённая тема');
  const dcb = api.sql('SELECT granted_micros FROM dcb_budget WHERE id = 1');
  assert.equal(dcb[0].granted_micros, 10_000_000);
  const chat = api.sql('SELECT granted_micros FROM buddy_chat_budget WHERE id = 1');
  assert.equal(chat[0].granted_micros, 1_000_000);
});
