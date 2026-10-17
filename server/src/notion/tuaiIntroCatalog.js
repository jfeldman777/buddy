// Buddy-018 step 3: «Введение в ТУАИ» — 13 Notion pages (Creator-supplied links).
// Official API ids; public mirror used only as a fallback for offline curriculum drafting.

export const TUAI_INTRO_CORPUS_ID = 'tuai-intro-2026-10';
export const TUAI_INTRO_CORPUS_TITLE = 'Введение в ТУАИ (октябрь 2026)';

/** @type {ReadonlyArray<{ n: number, pageId: string, sourceUrl: string }>} */
export const TUAI_INTRO_PAGES = Object.freeze([
  {
    n: 1,
    pageId: '3f622db3-cb08-8059-8c37-e17046263550',
    sourceUrl: 'https://app.notion.com/p/1-3f622db3cb0880598c37e17046263550',
  },
  {
    n: 2,
    pageId: '3f622db3-cb08-801c-8151-f2f415cd71de',
    sourceUrl: 'https://app.notion.com/p/2-3f622db3cb08801c8151f2f415cd71de',
  },
  {
    n: 3,
    pageId: '3f622db3-cb08-80ce-ae15-ea123fac6e24',
    sourceUrl: 'https://app.notion.com/p/3-3f622db3cb0880ceae15ea123fac6e24',
  },
  {
    n: 4,
    pageId: '3f622db3-cb08-80b5-9367-e0e5c6d6ae97',
    sourceUrl: 'https://app.notion.com/p/4-3f622db3cb0880b59367e0e5c6d6ae97',
  },
  {
    n: 5,
    pageId: '3f622db3-cb08-80a2-92ba-e51894294300',
    sourceUrl: 'https://app.notion.com/p/5-3f622db3cb0880a292bae51894294300',
  },
  {
    n: 6,
    pageId: '3f722db3-cb08-809b-9d63-e81928d37210',
    sourceUrl: 'https://app.notion.com/p/6-3f722db3cb08809b9d63e81928d37210',
  },
  {
    n: 7,
    pageId: '3f822db3-cb08-80cf-9dae-d250c5a9a2e8',
    sourceUrl: 'https://app.notion.com/p/7-3f822db3cb0880cf9daed250c5a9a2e8',
  },
  {
    n: 8,
    pageId: '3f822db3-cb08-80f1-8044-d81c0fc5363d',
    sourceUrl: 'https://app.notion.com/p/8-3f822db3cb0880f18044d81c0fc5363d',
  },
  {
    n: 9,
    pageId: '3f922db3-cb08-8060-8e3c-f0bda5cd00e8',
    sourceUrl: 'https://app.notion.com/p/9-3f922db3cb0880608e3cf0bda5cd00e8',
  },
  {
    n: 10,
    pageId: '3f922db3-cb08-8099-a54d-f8cc576a6a86',
    sourceUrl: 'https://app.notion.com/p/10-3f922db3cb088099a54df8cc576a6a86',
  },
  {
    n: 11,
    pageId: '3f922db3-cb08-80ac-83d1-efb2d75dc63f',
    sourceUrl: 'https://app.notion.com/p/11-3f922db3cb0880ac83d1efb2d75dc63f',
  },
  {
    n: 12,
    pageId: '3f922db3-cb08-803c-aed6-f638afd8225c',
    sourceUrl: 'https://app.notion.com/p/12-3f922db3cb08803caed6f638afd8225c',
  },
  {
    n: 13,
    pageId: '3f922db3-cb08-80c0-aa39-ee3e1c6a2c63',
    sourceUrl: 'https://app.notion.com/p/13-3f922db3cb0880c0aa39ee3e1c6a2c63',
  },
]);

export function assertTuaiIntroCatalog() {
  if (TUAI_INTRO_PAGES.length !== 13) {
    throw new Error(`Ожидалось 13 страниц, в каталоге ${TUAI_INTRO_PAGES.length}`);
  }
  const ids = new Set();
  for (const p of TUAI_INTRO_PAGES) {
    if (ids.has(p.pageId)) throw new Error(`Дубликат pageId: ${p.pageId}`);
    ids.add(p.pageId);
  }
  return true;
}
