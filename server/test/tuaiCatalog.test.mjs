import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUAI_INTRO_PAGES,
  TUAI_INTRO_CORPUS_ID,
  assertTuaiIntroCatalog,
} from '../src/notion/tuaiIntroCatalog.js';
import { normalizePageId } from '../src/notion/readPage.js';
import { readTuaiIntroCorpus } from '../src/notion/readCorpus.js';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { NOTION_API } from '../src/notion/readPage.js';

test('каталог Введение в ТУАИ: ровно 13 уникальных pageId', () => {
  assert.equal(TUAI_INTRO_PAGES.length, 13);
  assert.equal(TUAI_INTRO_CORPUS_ID, 'tuai-intro-2026-10');
  assert.equal(assertTuaiIntroCatalog(), true);
  const ids = TUAI_INTRO_PAGES.map((p) => p.pageId);
  assert.equal(new Set(ids).size, 13);
  for (const p of TUAI_INTRO_PAGES) {
    assert.equal(normalizePageId(p.pageId), p.pageId);
    assert.match(p.sourceUrl, /app\.notion\.com\/p\//);
    assert.equal(p.n, TUAI_INTRO_PAGES.indexOf(p) + 1);
  }
});

test('GET /admin/notion/corpus: admin читает каталог; без токена — ошибки страниц; user — 403', async () => {
  const api = await createEnv();
  assert.equal((await api.call('GET', '/admin/notion/corpus')).status, 401);

  const userKey = await createAuthenticator();
  const userReg = await registerWithPasskey(api, userKey);
  assert.equal(
    (await api.call('GET', '/admin/notion/corpus', { token: userReg.data.session.token })).status,
    403,
  );

  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  const token = login.data.session.token;

  const missing = await api.call('GET', '/admin/notion/corpus', { token });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.pageCount, 13);
  assert.equal(missing.data.complete, false);
  assert.equal(missing.data.errorCount, 13);

  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(NOTION_API)) return realFetch(url, init);
    if (href.includes('/v1/pages/')) {
      const id = href.split('/v1/pages/')[1].split('?')[0];
      return Response.json({
        object: 'page',
        id,
        properties: {
          title: { type: 'title', title: [{ plain_text: `Page ${id.slice(0, 8)}` }] },
        },
      });
    }
    if (href.includes('/children')) {
      const blockId = href.split('/v1/blocks/')[1].split('/children')[0];
      // Corpus mode must not recurse into child_page bodies of other chapters.
      return Response.json({
        object: 'list',
        results: [
          {
            object: 'block',
            id: `${blockId.slice(0, -1)}a`,
            type: 'paragraph',
            has_children: false,
            paragraph: { rich_text: [{ plain_text: 'Текст страницы корпуса.' }] },
          },
          {
            object: 'block',
            id: `${blockId.slice(0, -1)}b`,
            type: 'child_page',
            has_children: true,
            child_page: { title: 'Другая глава (не раскрывать в корпусе)' },
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    }
    return Response.json({ message: 'unexpected' }, { status: 500 });
  };

  const ok = await api.call('GET', '/admin/notion/corpus', { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.pageCount, 13);
  assert.equal(ok.data.okCount, 13);
  assert.equal(ok.data.complete, true);
  assert.equal(ok.data.pages[0].n, 1);
  assert.equal(ok.data.pages[12].n, 13);

  const direct = await readTuaiIntroCorpus(api.env);
  assert.equal(direct.complete, true);
});
