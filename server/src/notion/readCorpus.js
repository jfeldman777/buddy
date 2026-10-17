// Buddy-018 step 3: read the full TUAI intro catalog via official Notion API.
import { readNotionPage } from './readPage.js';
import { TUAI_INTRO_PAGES, TUAI_INTRO_CORPUS_ID, TUAI_INTRO_CORPUS_TITLE, assertTuaiIntroCatalog } from './tuaiIntroCatalog.js';

/**
 * @returns {Promise<{
 *   corpusId: string,
 *   title: string,
 *   pageCount: number,
 *   okCount: number,
 *   incompleteCount: number,
 *   errorCount: number,
 *   complete: boolean,
 *   pages: Array<{
 *     n: number,
 *     pageId: string,
 *     sourceUrl: string,
 *     status: 'ok' | 'incomplete' | 'error',
 *     title: string,
 *     text: string,
 *     charCount: number,
 *     complete: boolean,
 *     errors: unknown[],
 *     unknownBlockTypes: string[],
 *     error?: { code: string, message: string },
 *   }>,
 * }>}
 */
export async function readTuaiIntroCorpus(env) {
  assertTuaiIntroCatalog();
  const pages = [];
  for (const entry of TUAI_INTRO_PAGES) {
    try {
      // Per catalog page: own blocks + toggles; do not embed other chapters via child_page.
      const page = await readNotionPage(env, {
        pageId: entry.pageId,
        sourceUrl: entry.sourceUrl,
        expandLinkedPages: false,
      });
      const status = page.complete && (page.text || '').trim() ? 'ok' : 'incomplete';
      pages.push({
        n: entry.n,
        pageId: entry.pageId,
        sourceUrl: entry.sourceUrl,
        status,
        title: page.title || '',
        text: page.text || '',
        charCount: (page.text || '').length,
        complete: Boolean(page.complete),
        errors: page.errors || [],
        unknownBlockTypes: page.unknownBlockTypes || [],
      });
    } catch (err) {
      pages.push({
        n: entry.n,
        pageId: entry.pageId,
        sourceUrl: entry.sourceUrl,
        status: 'error',
        title: '',
        text: '',
        charCount: 0,
        complete: false,
        errors: [],
        unknownBlockTypes: [],
        error: {
          code: err?.code || 'notion_error',
          message: err?.message || 'Не удалось прочитать страницу.',
        },
      });
    }
  }

  const okCount = pages.filter((p) => p.status === 'ok').length;
  const incompleteCount = pages.filter((p) => p.status === 'incomplete').length;
  const errorCount = pages.filter((p) => p.status === 'error').length;

  return {
    corpusId: TUAI_INTRO_CORPUS_ID,
    title: TUAI_INTRO_CORPUS_TITLE,
    pageCount: pages.length,
    okCount,
    incompleteCount,
    errorCount,
    complete: okCount === pages.length && pages.length === 13,
    pages,
  };
}
