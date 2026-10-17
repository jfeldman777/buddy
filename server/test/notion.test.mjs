import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import {
  normalizePageId,
  findNotionPageRef,
  richTextToMarkdown,
  blocksToMarkdown,
  extractTitle,
  readNotionPage,
  FIRST_CHAPTER_PAGE_ID,
  FIRST_CHAPTER_SOURCE_URL,
  NOTION_API,
} from '../src/notion/readPage.js';
import { MEMORY_CONSENT_VERSION } from '../src/bi/consent.js';
import {
  resolveNotionPortion,
  sliceNotionPortion,
  NOTION_TEACH_TEXT_MAX,
} from '../src/bi/notionTeach.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  assert.equal(login.data.user.admin, true);
  return { token: login.data.session.token, userId: login.data.user.id };
}

function installNotionFixture(api, fixture) {
  const pageCalls = [];
  const childCalls = [];
  const cursors = new Map();
  const realFetch = api.env.FETCH;
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  api.env.FETCH = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(NOTION_API)) return realFetch(url, init);

    if (href.includes('/v1/pages/')) {
      pageCalls.push(href);
      const id = href.split('/v1/pages/')[1].split('?')[0];
      if (id !== fixture.page.id) {
        return Response.json({ message: 'Could not find page' }, { status: 404 });
      }
      return Response.json(fixture.page);
    }

    if (href.includes('/children')) {
      const u = new URL(href);
      const blockId = href.split('/v1/blocks/')[1].split('/children')[0];
      const start = u.searchParams.get('start_cursor') || null;
      childCalls.push({ blockId, start });
      const entry = fixture.children[blockId];
      if (!entry) {
        return Response.json({ object: 'list', results: [], has_more: false, next_cursor: null });
      }
      const pages = entry.pages;
      let index = 0;
      if (start) {
        const found = cursors.get(`${blockId}:${start}`);
        if (found == null) return Response.json({ message: 'bad cursor' }, { status: 400 });
        index = found;
      }
      const page = pages[index];
      if (page.has_more && page.next_cursor) {
        cursors.set(`${blockId}:${page.next_cursor}`, index + 1);
      }
      return Response.json({
        object: 'list',
        results: page.results,
        has_more: page.has_more,
        next_cursor: page.next_cursor,
      });
    }

    return Response.json({ message: 'unexpected notion url' }, { status: 500 });
  };
  return { pageCalls, childCalls };
}

test('normalizePageId: UUID, без дефисов и публичный префикс 1-', () => {
  assert.equal(normalizePageId('3f622db3-cb08-8059-8c37-e17046263550'), FIRST_CHAPTER_PAGE_ID);
  assert.equal(normalizePageId('3f622db3cb0880598c37e17046263550'), FIRST_CHAPTER_PAGE_ID);
  assert.equal(normalizePageId('1-3f622db3cb0880598c37e17046263550'), FIRST_CHAPTER_PAGE_ID);
  assert.throws(() => normalizePageId('not-an-id'), (err) => err.code === 'bad_page_id');
});

test('findNotionPageRef: app.notion.com и notion.so', () => {
  const a = findNotionPageRef(`Прочитай ${FIRST_CHAPTER_SOURCE_URL} пожалуйста`);
  assert.equal(a.pageId, FIRST_CHAPTER_PAGE_ID);
  assert.equal(a.sourceUrl, FIRST_CHAPTER_SOURCE_URL);
  const b = findNotionPageRef('https://www.notion.so/Title-3f622db3cb0880598c37e17046263550');
  assert.equal(b.pageId, FIRST_CHAPTER_PAGE_ID);
  assert.equal(findNotionPageRef('нет ссылки'), null);
});

test('порции Notion: slice и «дальше» / «часть N»', () => {
  const long = `${'А'.repeat(1000)}\n\n## Раздел\n\n${'Б'.repeat(NOTION_TEACH_TEXT_MAX)}`;
  const p0 = sliceNotionPortion(long, 0, 2000);
  assert.ok(p0.totalPortions >= 2);
  assert.equal(p0.portion, 0);
  assert.match(p0.text, /дальше/);
  const p1 = sliceNotionPortion(long, 1, 2000);
  assert.equal(p1.portion, 1);
  assert.match(p1.text, /продолжение/);

  const id = FIRST_CHAPTER_PAGE_ID;
  assert.equal(resolveNotionPortion(FIRST_CHAPTER_SOURCE_URL, [], id), 0);
  assert.equal(
    resolveNotionPortion('дальше', [{ role: 'user', text: FIRST_CHAPTER_SOURCE_URL }], id),
    1,
  );
  assert.equal(
    resolveNotionPortion('часть 3', [{ role: 'user', text: FIRST_CHAPTER_SOURCE_URL }], id),
    2,
  );
});

test('richText и блоки: заголовки, цитата, списки, ссылки, вложенность, неизвестный тип', () => {
  assert.equal(
    richTextToMarkdown([
      { plain_text: 'см. ', href: null },
      { plain_text: 'модель', href: 'https://example.com/model' },
    ]),
    'см. [модель](https://example.com/model)',
  );

  const { text, unknownBlockTypes } = blocksToMarkdown([
    {
      type: 'heading_1',
      heading_1: { rich_text: [{ plain_text: 'Глава' }] },
    },
    {
      type: 'quote',
      quote: { rich_text: [{ plain_text: 'Цитата' }] },
    },
    {
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ plain_text: 'Пункт' }] },
      children: [
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ plain_text: 'Вложенный' }] },
        },
      ],
    },
    {
      type: 'numbered_list_item',
      numbered_list_item: { rich_text: [{ plain_text: 'Один' }] },
    },
    {
      type: 'numbered_list_item',
      numbered_list_item: { rich_text: [{ plain_text: 'Два' }] },
    },
    {
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { plain_text: 'Ссылка ', href: null },
          { plain_text: 'сюда', href: 'https://example.com' },
        ],
      },
    },
    { type: 'mystery_block', mystery_block: {} },
  ]);

  assert.match(text, /^# Глава/m);
  assert.match(text, /^> Цитата/m);
  assert.match(text, /^- Пункт/m);
  assert.match(text, /^ {2}- Вложенный/m);
  assert.match(text, /^1\. Один/m);
  assert.match(text, /^2\. Два/m);
  assert.match(text, /\[сюда\]\(https:\/\/example\.com\)/);
  assert.match(text, /\[unsupported block: mystery_block\]/);
  assert.deepEqual(unknownBlockTypes, ['mystery_block']);
});

test('extractTitle из properties.title', () => {
  assert.equal(
    extractTitle({
      properties: {
        title: { type: 'title', title: [{ plain_text: '1.Картина мира: инженерный подход' }] },
      },
    }),
    '1.Картина мира: инженерный подход',
  );
});

test('readNotionPage: фикстура с пагинацией и вложенными блоками, без живого API', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/notion-first-chapter.json', import.meta.url), 'utf8'),
  );
  const api = await createEnv();
  const { childCalls } = installNotionFixture(api, fixture);

  const page = await readNotionPage(api.env, { pageId: FIRST_CHAPTER_PAGE_ID });
  assert.equal(page.pageId, FIRST_CHAPTER_PAGE_ID);
  assert.equal(page.sourceUrl, FIRST_CHAPTER_SOURCE_URL);
  assert.equal(page.title, '1.Картина мира: инженерный подход');
  assert.equal(page.complete, true);
  assert.match(page.text, /> Мир можно понять/);
  assert.match(page.text, /\[модели\]\(https:\/\/example\.com\/model\)/);
  assert.match(page.text, /## Шаги/);
  assert.match(page.text, /- Наблюдение/);
  assert.match(page.text, /^ {2}- Факты/m);
  assert.match(page.text, /1\. Гипотеза/);
  assert.match(page.text, /2\. Проверка/);
  assert.match(page.text, /Вторая страница пагинации/);
  assert.deepEqual(page.unknownBlockTypes, ['unsupported_widget']);
  assert.equal(page.errors.length, 0);

  const rootPages = childCalls.filter((c) => c.blockId === FIRST_CHAPTER_PAGE_ID);
  assert.equal(rootPages.length, 2, 'пагинация children: две страницы');
  assert.equal(rootPages[1].start, 'cursor-page-2');
  assert.ok(childCalls.some((c) => c.blockId === 'aaaa0001-0000-0000-0000-000000000004'));
});

test('readNotionPage: ошибка children отражается в errors и complete=false', async () => {
  const api = await createEnv();
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  api.env.FETCH = async (url) => {
    const href = String(url);
    if (href.includes('/v1/pages/')) {
      return Response.json({
        object: 'page',
        id: FIRST_CHAPTER_PAGE_ID,
        properties: { title: { type: 'title', title: [{ plain_text: 'X' }] } },
      });
    }
    if (href.includes('/children')) {
      return Response.json({ message: 'rate limited' }, { status: 429 });
    }
    return Response.json({ ok: true });
  };
  const page = await readNotionPage(api.env, {});
  assert.equal(page.complete, false);
  assert.equal(page.title, 'X');
  assert.ok(page.errors.length >= 1);
  assert.match(page.errors[0].message, /частот|лимит|Notion/i);
});

test('GET /admin/notion/page: только admin; без токена — unconfigured; с фикстурой — текст главы', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/notion-first-chapter.json', import.meta.url), 'utf8'),
  );
  const api = await createEnv();

  assert.equal((await api.call('GET', '/admin/notion/page')).status, 401);

  const userKey = await createAuthenticator();
  const userReg = await registerWithPasskey(api, userKey);
  assert.equal(
    (await api.call('GET', '/admin/notion/page', { token: userReg.data.session.token })).status,
    403,
  );

  const { token, userId } = await asAdmin(api);
  const missing = await api.call('GET', '/admin/notion/page', { token });
  assert.equal(missing.status, 503);
  assert.equal(missing.data.error, 'unconfigured');

  installNotionFixture(api, fixture);
  const ok = await api.call('GET', '/admin/notion/page', { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.title, '1.Картина мира: инженерный подход');
  assert.equal(ok.data.sourceUrl, FIRST_CHAPTER_SOURCE_URL);
  assert.equal(ok.data.pageId, FIRST_CHAPTER_PAGE_ID);
  assert.equal(ok.data.complete, true);
  assert.match(ok.data.text, /Вторая страница пагинации/);
  assert.deepEqual(ok.data.unknownBlockTypes, ['unsupported_widget']);

  const notionAudits = api.sql(
    "SELECT action FROM admin_audit WHERE admin_id = ? AND action LIKE 'notion_read:%'",
    userId,
  );
  assert.equal(notionAudits.length, 1);
  assert.match(notionAudits[0].action, /notion_read:3f622db3/);
});

test('chat/turn шаг 2: admin — Notion в промпт Би; обычный user — без fetch', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/notion-first-chapter.json', import.meta.url), 'utf8'),
  );
  const api = await createEnv();
  const { pageCalls } = installNotionFixture(api, fixture);
  api.env.OPENAI_API_KEY = 'test-key';

  const userKey = await createAuthenticator();
  const userReg = await registerWithPasskey(api, userKey);
  const userToken = userReg.data.session.token;
  await api.call('POST', '/chat/consent', { token: userToken, body: { accept: true, version: MEMORY_CONSENT_VERSION } });

  const openaiBodies = [];
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    const href = String(url);
    if (href.includes('openai.com')) {
      openaiBodies.push(JSON.parse(init.body));
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          utterance: 'Ок, без страницы.',
          summary: 'user без notion',
          open_threads: [],
          memory_candidates: [],
          used_knowledge_ids: [],
        }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 10 },
      });
    }
    return realFetch(url, init);
  };

  const userTurn = await api.call('POST', '/chat/turn', {
    token: userToken,
    body: { text: `Вот глава ${FIRST_CHAPTER_SOURCE_URL}` },
  });
  assert.equal(userTurn.status, 200);
  assert.equal(userTurn.data.notion?.ok, false);
  assert.equal(userTurn.data.notion?.error?.code, 'admin_only');
  assert.equal(pageCalls.length, 0);
  assert.match(JSON.stringify(openaiBodies[0].messages), /admin_only|администратора/i);

  const { token: adminToken, userId: adminId } = await asAdmin(api);
  await api.call('POST', '/chat/consent', { token: adminToken, body: { accept: true, version: MEMORY_CONSENT_VERSION } });
  openaiBodies.length = 0;

  const adminTurn = await api.call('POST', '/chat/turn', {
    token: adminToken,
    body: { text: `Учись по этой главе: ${FIRST_CHAPTER_SOURCE_URL}` },
  });
  assert.equal(adminTurn.status, 200);
  assert.equal(adminTurn.data.notion.ok, true);
  assert.equal(adminTurn.data.notion.pageId, FIRST_CHAPTER_PAGE_ID);
  assert.match(adminTurn.data.notion.title, /инженерный подход/);
  assert.ok(pageCalls.length >= 1);
  const blob = JSON.stringify(openaiBodies[0].messages);
  assert.match(blob, /Учебный материал из Notion/);
  assert.match(blob, /Вторая страница пагинации/);
  assert.match(blob, /не просите вставить текст|НЕ просите вставить текст/i);

  const teachAudits = api.sql(
    "SELECT action FROM admin_audit WHERE admin_id = ? AND action LIKE 'notion_teach:%'",
    adminId,
  );
  assert.equal(teachAudits.length, 1);
});
