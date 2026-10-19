import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { NOTION_API } from '../src/notion/readPage.js';
import { TUAI_INTRO_PAGES } from '../src/notion/tuaiIntroCatalog.js';
import { formatCorpusForPrompt, buildTeachSessionPrompt, searchCorpusExcerpts } from '../src/teach/sessionPrompts.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

function installNotionAndChatMocks(api) {
  const realFetch = api.env.FETCH;
  let openaiCalls = 0;
  api.env.FETCH = async (url, init) => {
    const href = String(url);
    if (href.startsWith(NOTION_API)) {
      if (href.includes('/v1/pages/')) {
        const m = href.match(/\/v1\/pages\/([^?/]+)/);
        const pageId = m ? decodeURIComponent(m[1]) : 'unknown';
        return Response.json({
          object: 'page',
          id: pageId,
          properties: { title: { type: 'title', title: [{ plain_text: `Глава ${pageId.slice(0, 6)}` }] } },
        });
      }
      if (href.includes('/children')) {
        return Response.json({
          object: 'list',
          results: [{
            object: 'block',
            id: 'bbbb0001-0000-0000-0000-000000000001',
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: [{ plain_text: 'Текст учебной главы для сессии 8A.' }] },
          }],
          has_more: false,
          next_cursor: null,
        });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    }
    if (href.includes('openai.com')) {
      openaiCalls += 1;
      const body = JSON.parse(init.body);
      const system = body.messages[0].content;
      assert.match(system, /режиме обучения|teach-session/i);
      assert.doesNotMatch(system, /три карты А|memory_candidates/i);
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'reply',
              utterance: 'Уточните, пожалуйста: какой уровень из корпуса имеется в виду?',
              kind: 'question',
            }),
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 12 },
      });
    }
    return realFetch(url, init);
  };
  return { getOpenaiCalls: () => openaiCalls };
}

test('formatCorpusForPrompt: только оглавление без автоподстановки тел', () => {
  const text = formatCorpusForPrompt([
    { n: 1, title: 'A', text: 'aaa', status: 'ok' },
    { n: 2, title: 'B', text: 'bbb', status: 'ok' },
  ]);
  assert.match(text, /Оглавление/);
  assert.match(text, /1\. A/);
  assert.doesNotMatch(text, /\baaa\b/);
});

test('searchCorpusExcerpts: ищет по всему корпусу', () => {
  const pages = [
    { n: 1, title: '01_Ввод', text: 'общие слова про знакомство и этикет '.repeat(40), status: 'ok' },
    { n: 4, title: '04_Уровни', text: 'Классификация уровней ситуации в Каноне: точка отсечения и шкала.', status: 'ok' },
    { n: 12, title: '12_Другое', text: 'совсем иная тема про кулинарию и рецепты', status: 'ok' },
  ];
  const hit = searchCorpusExcerpts(pages, 'нужна уровневая классификация и шкала отсечения');
  assert.ok(hit.parts.some((p) => /Классификация уровней/i.test(p)));
  assert.ok(hit.sourcePages.includes(4));
});

test('buildTeachSessionPrompt: Би сам ищет по Канону в обучении', () => {
  const p = buildTeachSessionPrompt({
    corpusTitle: 'ТУАИ',
    pages: [{ n: 1, title: 'A', text: 'материал', status: 'ok' }],
    messages: [{ role: 'creator', text: 'Объясни грани.' }],
  });
  assert.match(p.system, /ищите по всему корпусу/i);
  assert.match(p.system, /action":"search/);
  assert.match(p.system, /Создатель даёт задачи по одной/i);
  assert.match(p.system, /не оценивайте себя рубриками/i);
});

test('session start → ingest → turn; без записи в память чата', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  const mocks = installNotionAndChatMocks(api);
  const { token, userId } = await asAdmin(api);

  const pageIds = TUAI_INTRO_PAGES.slice(0, 2).map((p) => p.pageId);
  const started = await api.call('POST', '/admin/teach/session/start', {
    token,
    body: { pageIds },
  });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.session.status, 'ingesting');
  assert.equal(started.data.session.progress.total, 2);
  const sessionId = started.data.session.id;

  const earlyTurn = await api.call('POST', '/admin/teach/session/turn', {
    token,
    body: { sessionId, text: 'Рано' },
  });
  assert.equal(earlyTurn.status, 409);
  assert.equal(earlyTurn.data.error, 'teach_session_not_ready');

  const i1 = await api.call('POST', '/admin/teach/session/ingest', {
    token,
    body: { sessionId },
  });
  assert.equal(i1.status, 200);
  assert.equal(i1.data.done, false);
  assert.equal(i1.data.session.progress.loaded, 1);

  const i2 = await api.call('POST', '/admin/teach/session/ingest', {
    token,
    body: { sessionId },
  });
  assert.equal(i2.data.done, true);
  assert.equal(i2.data.session.status, 'ready');

  const memBefore = api.sql('SELECT COUNT(*) AS n FROM bi_memory_entries WHERE user_id = ?', userId);
  const teachBefore = api.sql('SELECT COUNT(*) AS n FROM bi_teachings WHERE user_id = ?', userId);

  const turn = await api.call('POST', '/admin/teach/session/turn', {
    token,
    body: { sessionId, text: 'Задача: назови четыре грани деятельности.' },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.data));
  assert.equal(turn.data.reply.kind, 'question');
  assert.match(turn.data.reply.utterance, /Уточните/);
  assert.equal(turn.data.isolation.wroteChatMemory, false);
  assert.equal(turn.data.isolation.wroteBiTeachings, false);
  assert.equal(mocks.getOpenaiCalls(), 1);
  assert.equal(turn.data.session.messages.length, 2);

  const memAfter = api.sql('SELECT COUNT(*) AS n FROM bi_memory_entries WHERE user_id = ?', userId);
  const teachAfter = api.sql('SELECT COUNT(*) AS n FROM bi_teachings WHERE user_id = ?', userId);
  assert.equal(memAfter[0].n, memBefore[0].n);
  assert.equal(teachAfter[0].n, teachBefore[0].n);
});
